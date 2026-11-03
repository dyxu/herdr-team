package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

func startupDirectory(env map[string]string) (string, error) {
	if directory := env["HERDR_PLUGIN_STATE_DIR"]; directory != "" {
		return directory, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	// Preserve the historical location after renaming the CLI.
	return filepath.Join(home, ".local", "state", "herdr-agent-team"), nil
}

func startupPath(directory, project, workspace string, env map[string]string) string {
	digest := sha256.Sum256([]byte(strings.Join([]string{env["HERDR_SOCKET_PATH"], env["HERDR_SESSION"], workspace, project}, "\x00")))
	return filepath.Join(directory, hex.EncodeToString(digest[:12])+".json")
}

// Hash the parsed effective configuration, including role and team instructions.
// Arguments and instructions are never printed in diagnostics.
func teamDigest(team Team) string {
	data, _ := json.Marshal(team)
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

func reportConfigChange(out io.Writer, state Startup, team Team) {
	if state.ConfigDigest == "" {
		fmt.Fprintln(out, "Configuration comparison unavailable: this team was started without a configuration digest. Close the old team and start again to apply current configuration.")
	} else if state.ConfigDigest != teamDigest(team) {
		fmt.Fprintln(out, "Configuration changed: the existing team still uses its startup configuration. Close the old team panes and start again to apply current configuration.")
	}
}

func reportStatus(client Client, path, project, workspace string, out io.Writer) error {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		fmt.Fprintf(out, "No startup record for this project in the current Herdr session. Project: %s\nUse start-team to start a team.\n", project)
		return nil
	}
	if err != nil {
		return err
	}
	var state Startup
	if err = json.Unmarshal(data, &state); err != nil {
		return fmt.Errorf("invalid startup record %s: %w", path, err)
	}
	if state.Project != project || state.WorkspaceID != workspace {
		return fmt.Errorf("startup record %s belongs to a different project or workspace", path)
	}
	fmt.Fprintf(out, "Project: %s\nTeam startup: %s\nStartup record: %s\n", project, state.Status, path)
	if state.Stage != "" {
		fmt.Fprintf(out, "Last startup stage: %s\n", state.Stage)
	}
	if state.Error != "" {
		fmt.Fprintf(out, "Startup error: %s\n", state.Error)
	}
	if team, configErr := loadTeam(project); configErr != nil {
		fmt.Fprintf(out, "Current configuration is invalid: %v\n", configErr)
	} else {
		reportConfigChange(out, state, team)
	}
	if len(state.Members) == 0 {
		fmt.Fprintln(out, "No member pane identities were recorded. Inspect the workspace for panes created before the failure; resolve them before removing the startup record and retrying.")
		return nil
	}
	agents, err := client.Call("agent", "list")
	if err != nil {
		printRecordedMembers(out, state)
		return fmt.Errorf("cannot query live members; recorded startup details shown above: %w", err)
	}
	panes, err := client.Call("pane", "list", "--workspace", workspace)
	if err != nil {
		printRecordedMembers(out, state)
		return fmt.Errorf("cannot query live panes; recorded startup details shown above: %w", err)
	}
	fmt.Fprintln(out, "Member\tStarted\tInitialized\tCurrent status\tInteractive ready\tPane")
	for _, member := range state.Members {
		current, ready := "missing", "-"
		for _, pane := range panes.Panes {
			if pane.PaneID == member.PaneID && pane.TerminalID == member.TerminalID {
				current = "pane only"
				break
			}
		}
		for _, agent := range agents.Agents {
			if agent.Name != member.Name || agent.WorkspaceID != workspace {
				continue
			}
			if agent.PaneID != member.PaneID || agent.TerminalID != member.TerminalID || agent.Kind != member.Kind {
				current = "identity changed"
				continue
			}
			current, ready = agent.Status, fmt.Sprint(agent.InteractiveReady)
			break
		}
		fmt.Fprintf(out, "%s (%s)\t%t\t%t\t%s\t%s\t%s\n", member.ID, member.Name, member.Started, member.Initialized, current, ready, member.PaneID)
	}
	if state.Status != "ready" {
		fmt.Fprintln(out, "Next: inspect member panes for login, permission prompts or errors. Partial teams are not resumed automatically; close their panes after inspection, then run start-team again. Never resend uncertain initialization prompts blindly.")
	} else {
		fmt.Fprintln(out, "Next: send work to the leader. For blocked members, inspect their panes for questions or login prompts. If members are missing or replaced, close the remaining old team panes before starting again.")
	}
	return nil
}

func printRecordedMembers(out io.Writer, state Startup) {
	for _, member := range state.Members {
		fmt.Fprintf(out, "%s (%s): started=%t initialized=%t pane=%s; live status unknown\n", member.ID, member.Name, member.Started, member.Initialized, member.PaneID)
	}
}
