package main

import (
	"reflect"
	"strings"
	"testing"
)

func TestParseAgentKindsHelp(t *testing.T) {
	for _, test := range []struct {
		name, help string
		want       []string
	}{
		{"current", "Options:\n      --kind <KIND>\n          Supported agent kind\n          [possible values: pi, claude, codex]\n      --pane <ID>\n", []string{"claude", "codex", "pi"}},
		{"wrapped", "  --kind <KIND>\n    [Possible Values:\n      codex,\n      claude, my-agent]\n  --pane <ID>\n", []string{"claude", "codex", "my-agent"}},
		{"color and CRLF", "\x1b[1m--kind\x1b[0m <KIND>\r\n  [possible values: codex, codex]\r\n", []string{"codex"}},
		{"other flag choices", "  --output <FORMAT> [possible values: json, text]\n  --kind <KIND> [possible values: codex]\n  --status <STATUS> [possible values: idle, done]\n", []string{"codex"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := parseAgentKindsHelp(test.help)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(sortedKinds(got), test.want) {
				t.Fatalf("got %v, want %v", sortedKinds(got), test.want)
			}
		})
	}
	for _, help := range []string{
		"[possible values: codex]",
		"--kind <KIND>\n--output <FORMAT> [possible values: codex]",
		"--kind <KIND> [possible values: ]",
		"--kind <KIND> [possible values: codex, ]",
		"--kind <KIND> [possible values: codex, BAD]",
		"--kind <KIND> [possible values: codex",
	} {
		if _, err := parseAgentKindsHelp(help); err == nil {
			t.Errorf("accepted malformed/ambiguous help: %q", help)
		}
	}
}

func TestCheckKindsCompatibilityDiagnostics(t *testing.T) {
	client := testExecutable(t, `if [ "$1" = "--version" ]; then
  printf '%s\n' 'herdr 0.9.5'
else
  printf '%s\n' '--output <FORMAT> [possible values: json]' '--kind <KIND> [possible values: codex, claude]' '--pane <ID>'
fi
`)
	if err := client.CheckKinds(Team{Members: []Member{{ID: "dev", Kind: "codex"}}}); err != nil {
		t.Fatal(err)
	}
	err := client.CheckKinds(Team{Members: []Member{{ID: "dev", Kind: "json", Args: []string{"secret-token"}}}})
	if err == nil {
		t.Fatal("accepted another option's choices")
	}
	for _, want := range []string{"herdr 0.9.5", `member "dev"`, "supported kinds: claude, codex", "edit"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("missing %q: %v", want, err)
		}
	}
	if strings.Contains(err.Error(), "secret-token") {
		t.Fatal("member arguments leaked")
	}
	client = testExecutable(t, `if [ "$1" = "--version" ]; then
  printf '%s\n' 'herdr 0.9.5'
else
  printf '%s\n' '--kind <KIND> changed help format'
fi
`)
	err = client.CheckKinds(Team{})
	if err == nil || !strings.Contains(err.Error(), "herdr 0.9.5") || !strings.Contains(err.Error(), "agent start --help") {
		t.Fatalf("missing actionable version diagnostic: %v", err)
	}
}

func TestCheckKindsVersionUnavailable(t *testing.T) {
	client := testExecutable(t, "exit 1\n")
	if got := client.versionLabel(); got != "Herdr (version unavailable)" {
		t.Fatal(got)
	}
}
