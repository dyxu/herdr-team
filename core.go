package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
)

// Core uses the published OpenRPC API over hc connect (plain JSON-RPC).
// Terminals have no workspace, tab or pane.
type Core struct{ Herdr }
type coreProgramStatus struct {
	State string `json:"state"`
	Kind  string `json:"kind,omitempty"`
	Msg   string `json:"msg,omitempty"`
}
type coreTerminal struct {
	Address string             `json:"address"`
	Name    string             `json:"name"`
	Cwd     string             `json:"cwd"`
	State   string             `json:"state"`
	Labels  map[string]string  `json:"labels"`
	Status  *coreProgramStatus `json:"status"`
}

func (t coreTerminal) status() string {
	if t.State != "live" {
		return t.State
	}
	if t.Status == nil {
		return "starting (no status report)"
	}
	return t.Status.State
}
func (c *Core) terminals() ([]coreTerminal, error) {
	var result struct {
		Terminals *[]coreTerminal `json:"terminals"`
	}
	if err := c.call(context.Background(), &result, "terminal.list", map[string]any{"all": true}); err != nil {
		return nil, err
	}
	if result.Terminals == nil {
		return nil, errors.New("terminal.list response is missing terminals; refusing to infer that the previous team is gone")
	}
	return *result.Terminals, nil
}
func coreMatches(t coreTerminal, m StartedMember, project, token string) bool {
	return t.Address == m.TerminalID && t.Name == m.Name && t.Cwd == project && t.Labels["herdr-team"] == token
}
func corePrompt(team Team, member Member, state Startup, binary string) string {
	var roster strings.Builder
	for _, m := range state.Members {
		fmt.Fprintf(&roster, "- %s: %s (terminal %s)\n", m.ID, m.Name, m.TerminalID)
	}
	cli := shellQuote(binary)
	prompt := fmt.Sprintf(`You are member %s of team %s.
This message installs your role only; it does not assign a task.
INITIALIZATION: Do not call tools, run commands, inspect files, send messages, or invoke any wait command.
"Wait for a task" means end your reply and leave the conversation idle, not execute herdr-core wait.
Shared project: %s
Leader: %s
Team roster (target these exact terminal addresses, not reusable names):
%s
Team instructions:
%s
Your role:
%s
All members share one worktree. Preserve existing changes. Only edit assigned files.
Coordinate overlapping edits and Git operations through the leader. Do not create worktrees.
Use herdr-core, not the legacy Herdr agent/pane commands. Never target terminals outside this roster.
Commands for future assigned tasks only (do not execute during initialization):
%s get <terminal>
%s send <terminal> 'instructions'
%s wait <terminal> --timeout 120
%s read <terminal> --lines 120
Use argv or proper shell quoting. Never interpolate untrusted text into shell code.
Only send tasks to settled idle/done members. Do not use --force to bypass blocked dialogs.
Use wait instead of sleep or polling. A timeout or not_started is not success; read before deciding and continue waiting without resending.
If wait returns reason=message, process the incoming message and continue waiting for the same turn.
Never blindly resend: a failed or timed-out send may already have arrived.
Read actual results: idle/done alone do not prove task success. Ask the user about permission or login dialogs.
Do not start additional agents or terminals outside this roster.
`, member.ID, team.Name, state.Project, state.LeaderName, roster.String(), team.Instructions, member.Instructions, cli, cli, cli, cli)
	initialization := fmt.Sprintf("\nFor THIS initialization message only, reply exactly: %s ready.\nThen END YOUR TURN. Do not call any tools or run commands. Do not send a readiness acknowledgement to the leader or another terminal. Do not assign tasks, inspect the project, monitor terminals, or execute wait. The launcher tracks initialization; no report or confirmation from another agent is needed.\n", member.ID)
	if member.ID == team.Leader {
		return prompt + "After the user supplies a goal in a later message, act as leader: assign scoped tasks to members, collect results with read, arrange review and run final verification. Never wait on yourself.\n" + initialization
	}
	leaderAddress := ""
	for _, m := range state.Members {
		if m.ID == team.Leader {
			leaderAddress = m.TerminalID
		}
	}
	return prompt + fmt.Sprintf("After completing a task assigned in a later message, report changes, checks and unresolved questions with %s send %s '<report>'; write long reports to a file and send its absolute path. After reporting, end your turn; do not wait on the leader or enter a monitoring loop.\n", cli, shellQuote(leaderAddress)) + initialization
}
func coreReady(out io.Writer, c *Core, state Startup) {
	fmt.Fprintf(out, "Team ready. Attach to the leader: %s attach %s\n", shellQuote(c.Bin), shellQuote(state.LeaderName))
}
func runCore(project string, status bool, entries []string, out io.Writer) error {
	if project == "" {
		project = "."
	}
	project, err := canonical(project)
	if err != nil {
		return err
	}
	info, err := os.Stat(project)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return errors.New("project path is not a directory")
	}
	env := envMap(entries)
	binary := env["HERDR_CORE_BIN_PATH"]
	if binary == "" {
		binary = "herdr-core"
	}
	c := &Core{Herdr{Bin: binary, Env: entries}}
	var server struct {
		Core struct {
			ID string `json:"id"`
		} `json:"core"`
	}
	if err = c.call(context.Background(), &server, "server.status", map[string]any{}); err != nil {
		return err
	}
	if server.Core.ID == "" {
		return errors.New("herdr-core server status is missing core identity")
	}
	directory, err := startupDirectory(env)
	if err != nil {
		return err
	}
	// Permanent core identity isolates old Herdr records and other cores/sessions.
	workspace := "core:" + server.Core.ID
	path := startupPath(directory, project, workspace, nil)
	if status {
		return coreStatus(c, path, project, workspace, out)
	}
	team, err := loadTeam(project)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(directory, 0700); err != nil {
		return err
	}
	unlock, err := lock(path + ".lock")
	if err != nil {
		return err
	}
	defer unlock()
	return startCore(c, team, project, workspace, path, out)
}
func coreStatus(c *Core, path, project, workspace string, out io.Writer) error {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		fmt.Fprintf(out, "No core team startup record. Project: %s\n", project)
		return nil
	}
	if err != nil {
		return err
	}
	var state Startup
	if err = json.Unmarshal(data, &state); err != nil {
		return err
	}
	if state.Project != project || state.WorkspaceID != workspace {
		return errors.New("core startup record belongs to another project or core")
	}
	fmt.Fprintf(out, "Project: %s\nTeam startup: %s\nLast startup stage: %s\nStartup record: %s\n", project, state.Status, state.Stage, path)
	if state.Error != "" {
		fmt.Fprintf(out, "Startup error: %s\n", state.Error)
	}
	if team, err := loadTeam(project); err == nil {
		reportConfigChange(out, state, team)
	} else {
		fmt.Fprintf(out, "Current configuration is invalid: %v\n", err)
	}
	terminals, err := c.terminals()
	if err != nil {
		printRecordedMembers(out, state)
		return err
	}
	fmt.Fprintln(out, "Member\tStarted\tInitialized\tCurrent status\tTerminal")
	for _, m := range state.Members {
		current := "missing or identity changed"
		for _, t := range terminals {
			if coreMatches(t, m, project, state.LeaderName) {
				current = t.status()
				break
			}
		}
		fmt.Fprintf(out, "%s\t%t\t%t\t%s\t%s\n", m.Name, m.Started, m.Initialized, current, m.TerminalID)
	}
	fmt.Fprintf(out, "Inspect members with %s get/read <terminal>; resolve dialogs before retrying.\n", shellQuote(c.Bin))
	return nil
}
func startCore(c *Core, team Team, project, workspace, path string, out io.Writer) (err error) {
	terminals, err := c.terminals()
	if err != nil {
		return err
	}
	data, readErr := os.ReadFile(path)
	if readErr != nil && !os.IsNotExist(readErr) {
		return readErr
	}
	if readErr == nil {
		var previous Startup
		if err = json.Unmarshal(data, &previous); err != nil {
			return err
		}
		if previous.Project != project || previous.WorkspaceID != workspace {
			return errors.New("core startup record belongs to another project or core")
		}
		live, matched := 0, 0
		for _, t := range terminals {
			// Labels also recover terminals whose launch response was lost.
			owned := t.Labels["herdr-team"] == previous.LeaderName
			for _, m := range previous.Members {
				owned = owned || t.Name == m.Name || (m.TerminalID != "" && t.Address == m.TerminalID)
			}
			if t.State == "live" && owned {
				live++
				for _, m := range previous.Members {
					if coreMatches(t, m, project, previous.LeaderName) {
						matched++
						break
					}
				}
			}
		}
		if previous.Status == "ready" && len(previous.Members) > 0 && matched == len(previous.Members) && live == matched {
			reportConfigChange(out, previous, team)
			coreReady(out, c, previous)
			return nil
		}
		if live > 0 {
			return fmt.Errorf("previous core team is incomplete; inspect %s and its labeled terminals, then close only that team's terminals before restarting; no prompts were resent", path)
		}
	}
	var nonce [4]byte
	if _, err = rand.Read(nonce[:]); err != nil {
		return err
	}
	prefix := "t" + hex.EncodeToString(nonce[:])
	state := Startup{Project: project, WorkspaceID: workspace, Status: "starting", Stage: "starting terminals", ConfigDigest: teamDigest(team), LeaderName: prefix + "-" + team.Leader}
	// Record every planned name before launching: failed responses cannot hide launches.
	for _, m := range team.Members {
		state.Members = append(state.Members, StartedMember{ID: m.ID, Name: prefix + "-" + m.ID, Kind: m.Kind})
	}
	if err = save(path, state); err != nil {
		return err
	}
	defer func() {
		if err != nil {
			state.Status = "partial"
			state.Error = err.Error()
			err = errors.Join(err, save(path, state))
			fmt.Fprintf(out, "Initialization stopped; terminals preserved. Startup record: %s\n", path)
		}
	}()
	for i, m := range team.Members {
		entry := &state.Members[i]
		argv := []string{"/usr/bin/env", m.Kind}
		if m.Kind == "codex" {
			argv = append(argv, "--no-daemon")
		}
		argv = append(argv, m.Args...)
		params := map[string]any{"argv": argv, "cwd": project, "name": entry.Name, "labels": map[string]string{"herdr-team": state.LeaderName}, "no_parent": true, "no_notify": true, "wait": false}
		fmt.Fprintf(out, "Starting %s (%s)…\n", entry.Name, m.Kind)
		var terminal coreTerminal
		if err = c.call(context.Background(), &terminal, "terminal.run", params); err != nil {
			return err
		}
		if terminal.Address == "" || terminal.Name != entry.Name || terminal.State != "live" {
			return fmt.Errorf("invalid core launch identity for %s; inspect by name before retrying", entry.Name)
		}
		entry.TerminalID = terminal.Address
		entry.Started = true
		if err = save(path, state); err != nil {
			return err
		}
	}
	state.Stage = "initializing roles"
	if err = save(path, state); err != nil {
		return err
	}
	// Non-leaders first, so the complete roster is available when the leader starts.
	order := []int{}
	leader := -1
	for i, m := range team.Members {
		if m.ID == team.Leader {
			leader = i
		} else {
			order = append(order, i)
		}
	}
	order = append(order, leader)
	for _, i := range order {
		entry := &state.Members[i]
		fmt.Fprintf(out, "%s: waiting for readiness…\n", entry.Name)
		if err = c.initializeRole(*entry, project, state.LeaderName, corePrompt(team, team.Members[i], state, c.Bin), out); err != nil {
			return err
		}
		entry.Initialized = true
		if err = save(path, state); err != nil {
			return err
		}
		fmt.Fprintf(out, "%s: initialized\n", entry.Name)
	}
	state.Status = "ready"
	state.Stage = "ready"
	if err = save(path, state); err != nil {
		return err
	}
	coreReady(out, c, state)
	return nil
}
