package main

import (
	"embed"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
)

//go:embed templates
var builtinTemplates embed.FS

func builtinTemplateNames() []string {
	entries, err := builtinTemplates.ReadDir("templates")
	if err != nil {
		panic(fmt.Sprintf("read embedded templates: %v", err))
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	return names
}

func validateTemplatesDirectory(directory string) error {
	if directory == "" {
		return nil
	}
	info, err := os.Stat(directory)
	if err != nil {
		return fmt.Errorf("templates directory %q: %w", directory, err)
	}
	if !info.IsDir() {
		return fmt.Errorf("templates directory %q is not a directory", directory)
	}
	return nil
}

func availableTemplateNames(directory string) ([]string, error) {
	if err := validateTemplatesDirectory(directory); err != nil {
		return nil, err
	}
	names := map[string]bool{}
	for _, name := range builtinTemplateNames() {
		names[name] = true
	}
	if directory != "" {
		entries, err := os.ReadDir(directory)
		if err != nil {
			return nil, fmt.Errorf("templates directory %q: %w", directory, err)
		}
		for _, entry := range entries {
			// DirEntry.IsDir does not follow symbolic links, matching selection.
			if !entry.IsDir() {
				continue
			}
			path := filepath.Join(directory, entry.Name())
			info, err := os.Lstat(filepath.Join(path, "TEAM.md"))
			if err != nil || !info.Mode().IsRegular() {
				continue
			}
			if err := checkTemplateTree(path); err != nil {
				continue
			}
			names[entry.Name()] = true
		}
	}
	result := make([]string, 0, len(names))
	for name := range names {
		result = append(result, name)
	}
	sort.Strings(result)
	return result, nil
}

// Only ordinary directories and files are copied. In particular, never follow
// template links or open a FIFO/device while validating Markdown.
func checkTemplateTree(root string) error {
	info, err := os.Lstat(root)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("template path is not a directory: %s", root)
	}
	return filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.IsDir() && !info.Mode().IsRegular() {
			return fmt.Errorf("template contains a symlink or special file: %s", path)
		}
		return nil
	})
}

func copyTemplate(source fs.FS, destination string) error {
	return fs.WalkDir(source, ".", func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		target := filepath.Join(destination, filepath.FromSlash(path))
		if entry.IsDir() {
			return os.MkdirAll(target, 0755)
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("template contains a symlink or special file: %s", path)
		}
		data, err := fs.ReadFile(source, path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, data, 0644)
	})
}

func selectTemplate(name, directory string) (fs.FS, string, error) {
	if name == "" {
		return nil, "", fmt.Errorf("template must be a name or directory")
	}
	if err := validateTemplatesDirectory(directory); err != nil {
		return nil, "", err
	}
	var path string
	if filepath.IsAbs(name) || strings.ContainsAny(name, `/\`) || name == "." || name == ".." {
		path = name
	} else if directory != "" {
		candidate := filepath.Join(directory, name)
		if _, err := os.Lstat(candidate); err == nil {
			path = candidate
		} else if !os.IsNotExist(err) {
			return nil, "", fmt.Errorf("template %q: %w", name, err)
		}
	}
	if path != "" {
		if err := checkTemplateTree(path); err != nil {
			return nil, "", fmt.Errorf("template %q: %w", name, err)
		}
		absolute, err := filepath.Abs(path)
		if err != nil {
			return nil, "", err
		}
		return os.DirFS(absolute), absolute, nil
	}
	for _, builtin := range builtinTemplateNames() {
		if name == builtin {
			source, err := fs.Sub(builtinTemplates, "templates/"+name)
			return source, "", err
		}
	}
	// A bare relative directory is also a valid explicit template. Named
	// configured and built-in templates win when the spelling is ambiguous;
	// callers can use ./NAME to force a local directory.
	if _, err := os.Lstat(name); err == nil {
		if err := checkTemplateTree(name); err != nil {
			return nil, "", fmt.Errorf("template %q: %w", name, err)
		}
		absolute, err := filepath.Abs(name)
		if err != nil {
			return nil, "", err
		}
		return os.DirFS(absolute), absolute, nil
	} else if !os.IsNotExist(err) {
		return nil, "", fmt.Errorf("template %q: %w", name, err)
	}
	return nil, "", fmt.Errorf("unknown template %q; use --list-templates or specify a template directory", name)
}

func initFromTemplate(project, name, directory string) error {
	project, err := canonical(project)
	if err != nil {
		return err
	}
	info, err := os.Stat(project)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("project path is not a directory: %s", project)
	}
	target := filepath.Join(project, ".team")
	if _, err := os.Lstat(target); err == nil {
		return fmt.Errorf("refusing to overwrite existing %s", target)
	} else if !os.IsNotExist(err) {
		return err
	}
	source, sourcePath, err := selectTemplate(name, directory)
	if err != nil {
		return err
	}
	if sourcePath != "" {
		sourcePath, err = canonical(sourcePath)
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(sourcePath, project)
		if err != nil {
			return err
		}
		if relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			return fmt.Errorf("template directory %q must not equal or contain project directory %q", sourcePath, project)
		}
	}
	// Stage in the project so the final rename stays on the same filesystem.
	staging, err := os.MkdirTemp(project, ".team-init-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(staging)
	stagedTeam := filepath.Join(staging, ".team")
	if sourcePath != "" {
		// loadTeam expects a project containing .team. This temporary wrapper
		// validates the original template before any template files are copied.
		if err = os.Symlink(sourcePath, stagedTeam); err != nil {
			return err
		}
		if _, err = loadTeam(staging); err != nil {
			return fmt.Errorf("invalid template %q: %w", name, err)
		}
		if err = os.Remove(stagedTeam); err != nil {
			return err
		}
	}
	if err = copyTemplate(source, stagedTeam); err != nil {
		return fmt.Errorf("copy template %q: %w", name, err)
	}
	if _, err = loadTeam(staging); err != nil {
		return fmt.Errorf("invalid template %q: %w", name, err)
	}
	// Reserve the destination exclusively: Rename alone could replace an existing
	// empty directory. Publish all files together, and remove our empty reservation
	// if publication fails. Never remove a directory somebody has populated.
	if err = os.Mkdir(target, 0755); err != nil {
		return fmt.Errorf("cannot create %s (refusing to overwrite): %w", target, err)
	}
	// os.Rename rejects an existing directory on some Go platforms, even
	// our empty reservation. The Unix rename primitive replaces it atomically.
	if err = syscall.Rename(stagedTeam, target); err != nil {
		_ = os.Remove(target)
		return fmt.Errorf("publish template: %w", err)
	}
	return nil
}
