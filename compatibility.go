package main

import (
	"errors"
	"regexp"
	"sort"
	"strings"
)

var ansiEscape = regexp.MustCompile(`\x1b\[[0-?]*[ -/]*[@-~]`)
var kindOption = regexp.MustCompile(`(?m)^\s*--kind(?:[= \t]|$)`)
var nextOption = regexp.MustCompile(`(?m)^\s*(?:-[a-zA-Z],?\s+)?--[a-zA-Z][a-zA-Z0-9-]*(?:[= \t]|$)`)
var possibleKinds = regexp.MustCompile(`(?is)\[\s*possible\s+values\s*:\s*([^\]]+)\]`)

// Scope choices to --kind: other flags can also publish possible values.
// Herdr's bundled API schema currently describes kind as a free-form string,
// so it cannot replace CLI capability discovery with an enum.
func parseAgentKindsHelp(help string) (map[string]bool, error) {
	help = ansiEscape.ReplaceAllString(strings.ReplaceAll(help, "\r\n", "\n"), "")
	option := kindOption.FindStringIndex(help)
	if option == nil {
		return nil, errors.New("--kind option is missing from help")
	}
	section := help[option[1]:]
	if next := nextOption.FindStringIndex(section); next != nil {
		section = section[:next[0]]
	}
	match := possibleKinds.FindStringSubmatch(section)
	if len(match) != 2 {
		return nil, errors.New("--kind choices are missing or use an unrecognized help format")
	}
	kinds := map[string]bool{}
	for _, item := range strings.Split(match[1], ",") {
		kind := strings.TrimSpace(item)
		if !validKind.MatchString(kind) {
			return nil, errors.New("--kind choices contain an invalid agent kind")
		}
		kinds[kind] = true
	}
	return kinds, nil
}

func sortedKinds(kinds map[string]bool) []string {
	result := make([]string, 0, len(kinds))
	for kind := range kinds {
		result = append(result, kind)
	}
	sort.Strings(result)
	return result
}

func (h *Herdr) versionLabel() string {
	data, err := h.execute("--version")
	if err != nil {
		return "Herdr (version unavailable)"
	}
	version := strings.Join(strings.Fields(ansiEscape.ReplaceAllString(string(data), "")), " ")
	if version == "" || len(version) > 120 {
		return "Herdr (version unavailable)"
	}
	return version
}
