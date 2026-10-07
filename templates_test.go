package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"syscall"
	"testing"
)

// Keep tests compatible with the module's Go 1.23 minimum.
func templateTestChdir(t *testing.T, directory string) {
	t.Helper()
	previous, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(directory); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Chdir(previous); err != nil {
			t.Error(err)
		}
	})
}

func templateFixture(t *testing.T) string {
	t.Helper()
	project, _, _ := fixture(t)
	return filepath.Join(project, ".team")
}

func assertNoTeam(t *testing.T, project string) {
	t.Helper()
	if _, err := os.Lstat(filepath.Join(project, ".team")); !os.IsNotExist(err) {
		t.Fatalf("unexpected .team: %v", err)
	}
	paths, err := filepath.Glob(filepath.Join(project, ".team-init-*"))
	if err != nil || len(paths) != 0 {
		t.Fatalf("staging leaked: %v %v", paths, err)
	}
}

var expectedBuiltinMembers = map[string][]string{
	"development":   {"leader", "developer", "reviewer"},
	"minimal":       {"leader", "developer"},
	"product":       {"leader", "product-manager", "architect", "developer", "qa"},
	"fullstack":     {"leader", "designer", "frontend", "backend", "reviewer"},
	"research":      {"leader", "researcher", "analyst", "reviewer"},
	"content":       {"leader", "researcher", "writer", "editor"},
	"data-analysis": {"leader", "data-engineer", "analyst", "reviewer"},
	"security":      {"leader", "auditor", "developer", "reviewer"},
}

func expectedTemplateList(extra ...string) string {
	names := map[string]bool{}
	for name := range expectedBuiltinMembers {
		names[name] = true
	}
	for _, name := range extra {
		names[name] = true
	}
	sorted := make([]string, 0, len(names))
	for name := range names {
		sorted = append(sorted, name)
	}
	sort.Strings(sorted)
	return strings.Join(sorted, "\n") + "\n"
}

func TestBuiltinTemplates(t *testing.T) {
	if got := strings.Join(builtinTemplateNames(), "\n") + "\n"; got != expectedTemplateList() {
		t.Fatalf("built-in discovery: %q", got)
	}
	for name, expected := range expectedBuiltinMembers {
		t.Run(name, func(t *testing.T) {
			project := t.TempDir()
			if err := initFromTemplate(project, name, ""); err != nil {
				t.Fatal(err)
			}
			team, err := loadTeam(project)
			if err != nil || team.Leader != "leader" || strings.TrimSpace(team.Instructions) == "" {
				t.Fatalf("%+v %v", team, err)
			}
			ids := make([]string, 0, len(team.Members))
			paths := make([]string, 0, len(team.Members))
			for _, member := range team.Members {
				ids = append(ids, member.ID)
				paths = append(paths, "members/"+member.ID+".md")
				if member.Kind != "codex" || len(member.Args) != 0 || strings.TrimSpace(member.Instructions) == "" {
					t.Fatal(member)
				}
				if name != "development" && name != "minimal" {
					if member.ID == "reviewer" || member.ID == "editor" || member.ID == "auditor" {
						if !strings.Contains(member.Instructions, "默认只读") {
							t.Fatalf("missing read-only boundary: %s/%s", name, member.ID)
						}
					}
					if member.ID == "leader" && !strings.Contains(member.Instructions, "实际成员名单") {
						t.Fatalf("leader ignores roster: %s", name)
					}
				}
			}
			if !reflect.DeepEqual(ids, expected) || !reflect.DeepEqual(team.Paths, paths) {
				t.Fatalf("%s roster=%v paths=%v want=%v", name, ids, team.Paths, expected)
			}
			if name != "development" && name != "minimal" {
				for _, required := range []string{"## 目标", "## 工作流程", "## 交接产物", "共享 worktree", "保留已有改动", "排定顺序", "Git", "Leader 统一协调", "后台服务"} {
					if !strings.Contains(team.Instructions, required) {
						t.Fatalf("%s missing %q", name, required)
					}
				}
			}
		})
	}
	// Built-in selection is independent of cwd/source files.
	templateTestChdir(t, t.TempDir())
	if err := run([]string{"--init"}, nil, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	if team, err := loadTeam("."); err != nil || len(team.Members) != 3 {
		t.Fatalf("%+v %v", team, err)
	}
}

func TestTemplateSelection(t *testing.T) {
	source := templateFixture(t)
	directory := t.TempDir()
	if err := copyTemplate(os.DirFS(source), filepath.Join(directory, "development")); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{
		{"--template", source},
		{"--template", "development", "--templates-dir", directory},
		{"--templates-dir", directory},
	} {
		project := t.TempDir()
		if err := run(append([]string{"--init", "--project", project}, args...), nil, &bytes.Buffer{}); err != nil {
			t.Fatal(err)
		}
		team, err := loadTeam(project)
		if err != nil || team.Name != "development" || len(team.Members) != 2 {
			t.Fatalf("custom selection: %+v %v", team, err)
		}
	}
	project := t.TempDir()
	if err := run([]string{"--init", "--project", project, "--template", "minimal", "--templates-dir", directory}, nil, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	if team, err := loadTeam(project); err != nil || team.Name != "minimal-team" {
		t.Fatalf("builtin fallback: %+v %v", team, err)
	}
}

func TestTemplatesDirectoryPrecedence(t *testing.T) {
	directory := t.TempDir()
	if err := copyTemplate(os.DirFS(templateFixture(t)), filepath.Join(directory, "development")); err != nil {
		t.Fatal(err)
	}
	env := []string{"HERDR_TEAM_TEMPLATES_DIR=" + directory}
	for _, test := range []struct {
		flags []string
		want  string
	}{
		{nil, "development"},
		{[]string{"--templates-dir", t.TempDir()}, "development-team"},
		{[]string{"--templates-dir="}, "development-team"},
	} {
		project := t.TempDir()
		args := append([]string{"--init", "--project", project}, test.flags...)
		if err := run(args, env, &bytes.Buffer{}); err != nil {
			t.Fatal(err)
		}
		team, err := loadTeam(project)
		if err != nil || team.Name != test.want {
			t.Fatalf("%+v %v", team, err)
		}
	}
}

func TestInvalidTemplatesLeaveNoOutput(t *testing.T) {
	bad := t.TempDir()
	write(t, filepath.Join(bad, "team.md"), "bad markdown")
	named := t.TempDir()
	if err := os.Mkdir(filepath.Join(named, "development"), 0755); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(named, "development", "team.md"), "bad markdown")
	file := filepath.Join(t.TempDir(), "file")
	write(t, file, "file")
	for _, test := range []struct{ name, directory, want string }{
		{"unknown", "", "unknown template"},
		{"", "", "template must"},
		{bad, "", "invalid template"},
		{"development", named, "invalid template"},
		{"development", file, "templates directory"},
		{"minimal", filepath.Join(t.TempDir(), "missing"), "templates directory"},
		{filepath.Join(t.TempDir(), "missing"), "", "template"},
	} {
		project := t.TempDir()
		err := initFromTemplate(project, test.name, test.directory)
		if err == nil || !strings.Contains(err.Error(), test.want) {
			t.Fatalf("%+v: %v", test, err)
		}
		assertNoTeam(t, project)
	}
}

func TestTemplateRejectsLinksAndSpecialFiles(t *testing.T) {
	for _, kind := range []string{"link", "dangling", "fifo", "root link"} {
		t.Run(kind, func(t *testing.T) {
			source := templateFixture(t)
			path := filepath.Join(source, "extra")
			switch kind {
			case "link":
				if err := os.Symlink(filepath.Join(source, "team.md"), path); err != nil {
					t.Fatal(err)
				}
			case "dangling":
				if err := os.Symlink("missing", path); err != nil {
					t.Fatal(err)
				}
			case "fifo":
				if err := syscall.Mkfifo(path, 0600); err != nil {
					t.Fatal(err)
				}
			case "root link":
				path = filepath.Join(t.TempDir(), "link")
				if err := os.Symlink(source, path); err != nil {
					t.Fatal(err)
				}
				source = path
			}
			project := t.TempDir()
			if err := initFromTemplate(project, source, ""); err == nil {
				t.Fatal("unsafe source accepted")
			}
			assertNoTeam(t, project)
		})
	}
}

func TestInitPreservesExistingTeam(t *testing.T) {
	for _, kind := range []string{"directory", "empty directory", "file", "link", "dangling"} {
		t.Run(kind, func(t *testing.T) {
			project := t.TempDir()
			target := filepath.Join(project, ".team")
			switch kind {
			case "directory":
				if err := os.Mkdir(target, 0755); err != nil {
					t.Fatal(err)
				}
				write(t, filepath.Join(target, "keep"), "untouched")
			case "empty directory":
				if err := os.Mkdir(target, 0755); err != nil {
					t.Fatal(err)
				}
			case "file":
				write(t, target, "untouched")
			case "link", "dangling":
				destination := filepath.Join(t.TempDir(), "destination")
				if kind == "link" {
					write(t, destination, "untouched")
				}
				if err := os.Symlink(destination, target); err != nil {
					t.Fatal(err)
				}
			}
			before, err := os.Lstat(target)
			if err != nil {
				t.Fatal(err)
			}
			if err := initFromTemplate(project, "minimal", ""); err == nil || !strings.Contains(err.Error(), "overwrite") {
				t.Fatal(err)
			}
			after, err := os.Lstat(target)
			if err != nil || !os.SameFile(before, after) {
				t.Fatalf("existing target replaced: %v", err)
			}
			if kind == "directory" {
				data, _ := os.ReadFile(filepath.Join(target, "keep"))
				if string(data) != "untouched" {
					t.Fatal("content changed")
				}
			}
			if kind == "file" || kind == "link" {
				data, _ := os.ReadFile(target)
				if string(data) != "untouched" {
					t.Fatal("content changed")
				}
			}
		})
	}
}

func TestInitHerdrProjectResolution(t *testing.T) {
	cwd := t.TempDir()
	templateTestChdir(t, cwd)
	for _, context := range []map[string]any{
		{"workspace_id": "w1", "workspace_cwd": t.TempDir()},
		{"workspace_id": "w1", "workspace_cwd": "/wrong", "worktree": map[string]string{"checkout_path": t.TempDir()}},
	} {
		raw, _ := json.Marshal(context)
		env := []string{"HERDR_ENV=1", "HERDR_PLUGIN_CONTEXT_JSON=" + string(raw), "HERDR_BIN_PATH=/must-not-start-agents"}
		if err := run([]string{"--init"}, env, &bytes.Buffer{}); err != nil {
			t.Fatal(err)
		}
		assertNoTeam(t, cwd)
		explicit := t.TempDir()
		if err := run([]string{"--init", "--project", explicit}, env, &bytes.Buffer{}); err != nil {
			t.Fatal(err)
		}
		if _, err := loadTeam(explicit); err != nil {
			t.Fatal(err)
		}
	}
	// Pane fallback may query Herdr to resolve the project, without starting agents.
	project := t.TempDir()
	client := testExecutable(t, "[ \"$1 $2 $3\" = \"pane get w1:p1\" ] || exit 9\n"+"printf '%s\\n' '{\"result\":{\"pane\":{\"cwd\":\""+project+"\"}}}'\n")
	if err := run([]string{"--init"}, []string{"HERDR_ENV=1", "HERDR_WORKSPACE_ID=w1", "HERDR_PANE_ID=w1:p1", "HERDR_BIN_PATH=" + client.Bin}, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	if _, err := loadTeam(project); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"--init"}, []string{"HERDR_ENV=1"}, &bytes.Buffer{}); err == nil {
		t.Fatal("missing workspace accepted")
	}
}

func TestTemplateCLIConflictsAndListing(t *testing.T) {
	for _, args := range [][]string{
		{"--init", "--check"}, {"--init", "--list-templates"}, {"--check", "--list-templates"},
		{"--template", "minimal"}, {"--check", "--template", "development"},
		{"--templates-dir", "anything"}, {"--check", "--templates-dir", "anything"},
		{"--list-templates", "--template", "minimal"}, {"--init", "unexpected"},
	} {
		if err := run(args, nil, &bytes.Buffer{}); err == nil {
			t.Fatalf("conflict accepted: %v", args)
		}
	}
	var out bytes.Buffer
	if err := run([]string{"--list-templates"}, []string{"HERDR_ENV=1", "HERDR_PLUGIN_CONTEXT_JSON=invalid"}, &out); err != nil {
		t.Fatal(err)
	}
	if out.String() != expectedTemplateList() {
		t.Fatal(out.String())
	}
}

func TestRelativeTemplateDirectoryAndExtraFiles(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "custom")
	if err := copyTemplate(os.DirFS(templateFixture(t)), source); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(source, "NOTES.txt"), "edit me")
	templateTestChdir(t, root)
	for _, name := range []string{"custom", "./custom"} {
		project := t.TempDir()
		if err := initFromTemplate(project, name, ""); err != nil {
			t.Fatal(err)
		}
		data, err := os.ReadFile(filepath.Join(project, ".team", "NOTES.txt"))
		if err != nil || string(data) != "edit me" {
			t.Fatalf("copy lost auxiliary file: %s %v", data, err)
		}
		write(t, filepath.Join(project, ".team", "NOTES.txt"), "edited")
		original, _ := os.ReadFile(filepath.Join(source, "NOTES.txt"))
		if string(original) != "edit me" {
			t.Fatal("source template changed")
		}
	}
}

func TestInitRejectsNonDirectoryProject(t *testing.T) {
	path := filepath.Join(t.TempDir(), "file")
	write(t, path, "unchanged")
	if err := run([]string{"--init", "--project", path}, nil, &bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), "project path is not a directory") {
		t.Fatal(err)
	}
}

func snapshotTemplate(t *testing.T, root string) map[string]string {
	t.Helper()
	result := map[string]string{}
	if err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		if entry.IsDir() {
			result[relative] = "directory"
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		result[relative] = string(data)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return result
}

func TestInitRejectsSourceContainingProject(t *testing.T) {
	for _, kind := range []string{"equal", "ancestor", "canonical equal", "canonical ancestor"} {
		t.Run(kind, func(t *testing.T) {
			source := templateFixture(t)
			project := source
			if strings.Contains(kind, "ancestor") {
				project = filepath.Join(source, "nested", "project")
				if err := os.MkdirAll(project, 0755); err != nil {
					t.Fatal(err)
				}
			}
			before := snapshotTemplate(t, source)
			if strings.HasPrefix(kind, "canonical") {
				alias := filepath.Join(t.TempDir(), "alias")
				if err := os.Symlink(project, alias); err != nil {
					t.Fatal(err)
				}
				project = filepath.Join(alias, ".")
			}
			err := initFromTemplate(project, source, "")
			if err == nil || !strings.Contains(err.Error(), "must not equal or contain project") {
				t.Fatal(err)
			}
			assertNoTeam(t, project)
			after := snapshotTemplate(t, source)
			if !reflect.DeepEqual(before, after) {
				t.Fatalf("source changed: before=%v after=%v", before, after)
			}
		})
	}
	// A sibling whose name shares a prefix must remain usable.
	root := t.TempDir()
	source := filepath.Join(root, "team")
	if err := copyTemplate(os.DirFS(templateFixture(t)), source); err != nil {
		t.Fatal(err)
	}
	project := filepath.Join(root, "team-project")
	if err := os.Mkdir(project, 0755); err != nil {
		t.Fatal(err)
	}
	if err := initFromTemplate(project, source, ""); err != nil {
		t.Fatal(err)
	}
}

func TestListConfiguredTemplates(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"zebra", "development", "alpha"} {
		if err := copyTemplate(os.DirFS(templateFixture(t)), filepath.Join(root, name)); err != nil {
			t.Fatal(err)
		}
	}
	write(t, filepath.Join(root, "file"), "misc")
	if err := os.Mkdir(filepath.Join(root, "no-team"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "alpha"), filepath.Join(root, "linked")); err != nil {
		t.Fatal(err)
	}
	if err := copyTemplate(os.DirFS(templateFixture(t)), filepath.Join(root, "linked-member")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("team.md", filepath.Join(root, "linked-member", "extra")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "team-is-directory"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "team-is-directory", "team.md"), 0755); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		args, env []string
		want      string
	}{
		{[]string{"--list-templates", "--templates-dir", root}, nil, expectedTemplateList("alpha", "development", "zebra")},
		{[]string{"--list-templates"}, []string{"HERDR_TEAM_TEMPLATES_DIR=" + root, "HERDR_ENV=1", "HERDR_PLUGIN_CONTEXT_JSON=invalid"}, expectedTemplateList("alpha", "development", "zebra")},
		{[]string{"--list-templates", "--templates-dir", root}, []string{"HERDR_TEAM_TEMPLATES_DIR=/invalid"}, expectedTemplateList("alpha", "development", "zebra")},
		{[]string{"--list-templates", "--templates-dir="}, []string{"HERDR_TEAM_TEMPLATES_DIR=/invalid"}, expectedTemplateList()},
	} {
		var out bytes.Buffer
		if err := run(test.args, test.env, &out); err != nil {
			t.Fatal(err)
		}
		if out.String() != test.want {
			t.Fatalf("got %q want %q", out.String(), test.want)
		}
	}
	project := t.TempDir()
	if err := run([]string{"--init", "--project", project, "--templates-dir", root}, nil, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	team, err := loadTeam(project)
	if err != nil || team.Name != "development" {
		t.Fatalf("listed override not selected: %+v %v", team, err)
	}
}

func TestListTemplatesInvalidRoot(t *testing.T) {
	file := filepath.Join(t.TempDir(), "file")
	write(t, file, "misc")
	for _, root := range []string{file, filepath.Join(t.TempDir(), "missing")} {
		for _, useEnv := range []bool{false, true} {
			args := []string{"--list-templates"}
			var env []string
			if useEnv {
				env = []string{"HERDR_TEAM_TEMPLATES_DIR=" + root}
			} else {
				args = append(args, "--templates-dir", root)
			}
			var out bytes.Buffer
			err := run(args, env, &out)
			if err == nil || !strings.Contains(err.Error(), "templates directory") {
				t.Fatal(err)
			}
			if out.Len() != 0 {
				t.Fatalf("partial list printed: %s", out.String())
			}
		}
	}
}
