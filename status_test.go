package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTeamDigestIncludesEffectiveConfiguration(t *testing.T) {
	_, _, team := fixture(t)
	initial := teamDigest(team)
	if teamDigest(team) != initial {
		t.Fatal("digest is unstable")
	}
	for _, change := range []func(*Team){
		func(team *Team) { team.Instructions += " changed" },
		func(team *Team) { team.Members[0].Instructions += " changed" },
		func(team *Team) { team.Members[0].Args = []string{"--model", "different"} },
		func(team *Team) { team.Leader = "dev" },
	} {
		copy := team
		copy.Members = append([]Member(nil), team.Members...)
		change(&copy)
		if teamDigest(copy) == initial {
			t.Fatal("effective configuration change missed")
		}
	}
}

func TestReuseWarnsOnChangedConfiguration(t *testing.T) {
	project, directory, team := fixture(t)
	client := &fakeHerdr{}
	if err := start(t, team, project, directory, client); err != nil {
		t.Fatal(err)
	}
	state := startup(t, directory)
	if state.ConfigDigest != teamDigest(team) || state.Stage != "ready" {
		t.Fatal("configuration and stage not saved", state)
	}
	team.Members[0].Instructions += " updated role"
	var out bytes.Buffer
	if err := initialize(team, project, "w1", directory, map[string]string{"HERDR_SOCKET_PATH": "/socket"}, client, &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "existing team still uses its startup configuration") {
		t.Fatal(out.String())
	}
	if startup(t, directory).ConfigDigest != state.ConfigDigest {
		t.Fatal("reuse overwrote original configuration digest")
	}
}

func TestStatusReportsLiveAndRecordedStateWithoutMutation(t *testing.T) {
	project, directory, team := fixture(t)
	client := &fakeHerdr{}
	if err := start(t, team, project, directory, client); err != nil {
		t.Fatal(err)
	}
	path := startupPath(directory, project, "w1", map[string]string{"HERDR_SOCKET_PATH": "/socket"})
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	client.Agents[0].Status = "blocked"
	client.Agents[0].InteractiveReady = false
	client.Agents[1].TerminalID = "replaced-terminal"
	client.Calls = nil
	var out bytes.Buffer
	if err := reportStatus(client, path, project, "w1", &out); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"Team startup: ready", "Last startup stage: ready", "blocked", "identity changed", "Initialized"} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("missing %q: %s", want, out.String())
		}
	}
	if len(client.Calls) != 2 || strings.Join(client.Calls[0], " ") != "agent list" || strings.Join(client.Calls[1], " ") != "pane list --workspace w1" {
		t.Fatal("status issued mutation", client.Calls)
	}
	after, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("status changed startup record", err)
	}
}

func TestStatusMissingAndUncertainRecords(t *testing.T) {
	project, directory, _ := fixture(t)
	path := filepath.Join(directory, "missing.json")
	client := &fakeHerdr{}
	var out bytes.Buffer
	if err := reportStatus(client, path, project, "w1", &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "No startup record") || len(client.Calls) != 0 {
		t.Fatal(out.String(), client.Calls)
	}
	if _, err := os.Stat(directory); !os.IsNotExist(err) {
		t.Fatal("status created state directory")
	}
	if err := os.Mkdir(directory, 0700); err != nil {
		t.Fatal(err)
	}
	state := Startup{Project: project, WorkspaceID: "w1", Status: "partial", Stage: "creating panes", Error: "timeout; delivery uncertain"}
	if err := save(path, state); err != nil {
		t.Fatal(err)
	}
	out.Reset()
	if err := reportStatus(client, path, project, "w1", &out); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"delivery uncertain", "No member pane identities", "creating panes"} {
		if !strings.Contains(out.String(), want) {
			t.Fatal(out.String())
		}
	}
	if len(client.Calls) != 0 {
		t.Fatal(client.Calls)
	}
}

func TestStatusCLIContextAndConflicts(t *testing.T) {
	project, directory, _ := fixture(t)
	context, _ := json.Marshal(map[string]string{"workspace_id": "w1", "workspace_cwd": project})
	env := []string{"HERDR_ENV=1", "HERDR_PLUGIN_CONTEXT_JSON=" + string(context), "HERDR_PLUGIN_STATE_DIR=" + directory}
	var out bytes.Buffer
	if err := run([]string{"--status"}, env, &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), project) {
		t.Fatal(out.String())
	}
	other := t.TempDir()
	out.Reset()
	if err := run([]string{"--status", "--project", other}, env, &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), other) {
		t.Fatal(out.String())
	}
	for _, args := range [][]string{{"--status", "--init"}, {"--status", "--check"}, {"--status", "--list-templates"}, {"--status", "--template", "minimal"}} {
		if err := run(args, env, &bytes.Buffer{}); err == nil {
			t.Fatal("conflict accepted", args)
		}
	}
	if err := run([]string{"--backend", "herdr", "--status", "--project", project}, nil, &bytes.Buffer{}); err == nil {
		t.Fatal("status without session accepted")
	}
}

func TestStatusPartialTeamAndInvalidConfiguration(t *testing.T) {
	project, directory, team := fixture(t)
	client := &fakeHerdr{FailStart: "dev"}
	if err := start(t, team, project, directory, client); err == nil {
		t.Fatal("expected partial startup")
	}
	path := startupPath(directory, project, "w1", map[string]string{"HERDR_SOCKET_PATH": "/socket"})
	if err := os.Remove(filepath.Join(project, ".team", "team.md")); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := reportStatus(client, path, project, "w1", &out); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"Team startup: partial", "starting agents", "agent_not_ready", "Current configuration is invalid", "pane only", "Partial teams are not resumed automatically"} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("missing %q: %s", want, out.String())
		}
	}
	client.Panes = nil
	out.Reset()
	if err := reportStatus(client, path, project, "w1", &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "missing") {
		t.Fatal(out.String())
	}
}

func TestConfigurationComparisonLegacyAndUnchanged(t *testing.T) {
	_, _, team := fixture(t)
	var out bytes.Buffer
	reportConfigChange(&out, Startup{ConfigDigest: teamDigest(team)}, team)
	if out.Len() != 0 {
		t.Fatal("unchanged configuration warned", out.String())
	}
	reportConfigChange(&out, Startup{}, team)
	if !strings.Contains(out.String(), "comparison unavailable") {
		t.Fatal(out.String())
	}
}
