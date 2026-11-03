package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Opt-in only: this test launches two real agents and may consume API credits.
// It only closes the tab it created, never any existing team or workspace.
func TestHerdrIntegration(t *testing.T) {
	if os.Getenv("HERDR_TEAM_INTEGRATION") != "1" {
		t.Skip("set HERDR_TEAM_INTEGRATION=1 inside Herdr to launch a real minimal team")
	}
	if os.Getenv("HERDR_ENV") != "1" {
		t.Fatal("real integration verification must run inside Herdr")
	}
	entries := os.Environ()
	env := envMap(entries)
	binary := env["HERDR_BIN_PATH"]
	if binary == "" {
		binary = "herdr"
	}
	client := &Herdr{Env: entries, Bin: binary}
	project, err := canonical(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := initFromTemplate(project, "minimal", ""); err != nil {
		t.Fatal(err)
	}
	team, err := loadTeam(project)
	if err != nil {
		t.Fatal(err)
	}
	_, workspace, err := resolveProject(env, client, project)
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	path := startupPath(directory, project, workspace, env)
	t.Cleanup(func() {
		data, err := os.ReadFile(path)
		if err != nil {
			return
		}
		var state Startup
		if err := json.Unmarshal(data, &state); err != nil {
			t.Errorf("cannot read test startup record for cleanup: %v", err)
			return
		}
		if state.TabID != "" && state.Project == project && state.WorkspaceID == workspace {
			if _, err := client.Call("tab", "close", state.TabID); err != nil {
				t.Errorf("close test tab %s: %v", state.TabID, err)
			}
		}
		if tab := env["HERDR_TAB_ID"]; tab != "" {
			if _, err := client.Call("tab", "focus", tab); err != nil {
				t.Errorf("restore caller tab: %v", err)
			}
		}
	})
	var output bytes.Buffer
	startErr := initialize(team, project, workspace, directory, env, client, &output)
	t.Log(output.String())
	output.Reset()
	statusErr := reportStatus(client, path, project, workspace, &output)
	t.Log(output.String())
	if startErr != nil {
		t.Fatalf("real startup failed (no approval dialogs were answered): %v", startErr)
	}
	if statusErr != nil {
		t.Fatal(statusErr)
	}
	if !strings.Contains(output.String(), "Team startup: ready") {
		t.Fatal("real team did not reach ready state")
	}
	if strings.Contains(output.String(), "Configuration changed:") || strings.Contains(output.String(), "comparison unavailable") {
		t.Fatal("unchanged real team configuration was reported as different")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	output.Reset()
	if err := initialize(team, project, workspace, directory, env, client, &output); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), "Existing team focused:") {
		t.Fatal("second startup did not reuse the existing team")
	}
	after, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(data, after) {
		t.Fatal("reusing a ready team changed its startup record")
	}
	memberPath := filepath.Join(project, ".team", team.Paths[0])
	file, err := os.OpenFile(memberPath, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	_, writeErr := file.WriteString("\nIntegration verification configuration change.\n")
	closeErr := file.Close()
	if writeErr != nil || closeErr != nil {
		t.Fatalf("change test role: %v; %v", writeErr, closeErr)
	}
	output.Reset()
	if err := reportStatus(client, path, project, workspace, &output); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), "Configuration changed:") {
		t.Fatal("configuration change was not reported")
	}
}
