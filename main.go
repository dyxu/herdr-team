// Herdr Team initializes a Markdown-defined team in a Herdr project.
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"

	"gopkg.in/yaml.v3"
)

type Member struct {
	ID           string   `yaml:"id"`
	Kind         string   `yaml:"kind"`
	Args         []string `yaml:"args"`
	Instructions string   `yaml:"-"`
}
type Team struct {
	Name         string   `yaml:"name"`
	Leader       string   `yaml:"leader"`
	Paths        []string `yaml:"members"`
	Members      []Member `yaml:"-"`
	Instructions string   `yaml:"-"`
}

var validID = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,19}$`)
var validKind = regexp.MustCompile(`^[a-z][a-z0-9_-]*$`)

func markdown(path string, target any) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	lines := strings.Split(strings.ReplaceAll(strings.TrimPrefix(string(data), "\ufeff"), "\r\n", "\n"), "\n")
	if len(lines) == 0 || strings.TrimSpace(lines[0]) != "---" {
		return "", fmt.Errorf("%s: expected YAML frontmatter", path)
	}
	end := 0
	for i := 1; i < len(lines); i++ {
		if strings.TrimSpace(lines[i]) == "---" {
			end = i
			break
		}
	}
	if end == 0 {
		return "", fmt.Errorf("%s: frontmatter is not closed", path)
	}
	frontmatter := strings.Join(lines[1:end], "\n")
	var document yaml.Node
	if err = yaml.Unmarshal([]byte(frontmatter), &document); err != nil {
		return "", fmt.Errorf("%s: %w", path, err)
	}
	if len(document.Content) != 1 || document.Content[0].Kind != yaml.MappingNode {
		return "", fmt.Errorf("%s: frontmatter must be a mapping", path)
	}
	// YAML otherwise coerces numbers and booleans into Go strings. Preserve
	// argument types so a mistaken configuration cannot change CLI behavior.
	fields := document.Content[0].Content
	for i := 0; i < len(fields); i += 2 {
		key, value := fields[i], fields[i+1]
		if key.Tag != "!!str" {
			return "", fmt.Errorf("%s: frontmatter keys must be strings", path)
		}
		if key.Value == "args" || key.Value == "members" {
			if value.Kind != yaml.SequenceNode {
				return "", fmt.Errorf("%s: %s must be a list of strings", path, key.Value)
			}
			for _, item := range value.Content {
				if item.Kind != yaml.ScalarNode || item.Tag != "!!str" {
					return "", fmt.Errorf("%s: %s must contain strings only", path, key.Value)
				}
			}
		} else if value.Kind != yaml.ScalarNode || value.Tag != "!!str" {
			return "", fmt.Errorf("%s: %s must be a string", path, key.Value)
		}
	}
	decoder := yaml.NewDecoder(strings.NewReader(frontmatter))
	decoder.KnownFields(true)
	if err = decoder.Decode(target); err != nil {
		return "", fmt.Errorf("%s: %w", path, err)
	}
	var extra any
	if err = decoder.Decode(&extra); err != io.EOF {
		return "", fmt.Errorf("%s: expected one YAML document", path)
	}
	return strings.TrimSpace(strings.Join(lines[end+1:], "\n")), nil
}
func canonical(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(absolute)
}
func loadTeam(project string) (Team, error) {
	var team Team
	directory, err := canonical(filepath.Join(project, ".team"))
	if err != nil {
		return team, err
	}
	team.Instructions, err = markdown(filepath.Join(directory, "team.md"), &team)
	if err != nil {
		return team, err
	}
	if team.Name == "" {
		team.Name = "team"
	}
	if strings.TrimSpace(team.Name) == "" || strings.ContainsAny(team.Name, "\x00\r\n") {
		return team, errors.New("team name must be a nonempty single-line string")
	}
	if !validID.MatchString(team.Leader) {
		return team, errors.New("leader must be a member ID: 1–20 lowercase letters, digits, underscores or hyphens, beginning with a letter")
	}
	if len(team.Paths) == 0 {
		return team, errors.New("members must be a nonempty list of Markdown paths")
	}
	seen := map[string]bool{}
	for _, relative := range team.Paths {
		if filepath.IsAbs(relative) {
			return team, fmt.Errorf("member path must be relative to .team: %s", relative)
		}
		path, err := canonical(filepath.Join(directory, relative))
		if err != nil {
			return team, err
		}
		rel, err := filepath.Rel(directory, path)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.Ext(path) != ".md" {
			return team, fmt.Errorf("member path must be a Markdown file inside .team: %s", relative)
		}
		var member Member
		member.Instructions, err = markdown(path, &member)
		if err != nil {
			return team, err
		}
		if !validID.MatchString(member.ID) {
			return team, fmt.Errorf("%s: invalid member ID (1–20 lowercase letters/digits/_/-, beginning with a letter)", path)
		}
		if seen[member.ID] {
			return team, fmt.Errorf("duplicate member ID: %s", member.ID)
		}
		if !validKind.MatchString(member.Kind) {
			return team, fmt.Errorf("%s: kind must name a Herdr agent kind", path)
		}
		for _, arg := range member.Args {
			if strings.ContainsRune(arg, 0) {
				return team, fmt.Errorf("%s: args cannot contain NUL", path)
			}
		}
		seen[member.ID] = true
		team.Members = append(team.Members, member)
	}
	if !seen[team.Leader] {
		return team, fmt.Errorf("leader %q is not a team member", team.Leader)
	}
	return team, nil
}

type Agent struct {
	Name             string `json:"name"`
	PaneID           string `json:"pane_id"`
	TerminalID       string `json:"terminal_id"`
	WorkspaceID      string `json:"workspace_id"`
	Kind             string `json:"agent"`
	Status           string `json:"agent_status"`
	Cwd              string `json:"cwd"`
	InteractiveReady bool   `json:"interactive_ready"`
}
type Pane struct {
	PaneID     string `json:"pane_id"`
	TerminalID string `json:"terminal_id"`
	Cwd        string `json:"cwd"`
}
type Result struct {
	Agent    Agent   `json:"agent"`
	Agents   []Agent `json:"agents"`
	Pane     Pane    `json:"pane"`
	Panes    []Pane  `json:"panes"`
	RootPane Pane    `json:"root_pane"`
	Tab      struct {
		ID string `json:"tab_id"`
	} `json:"tab"`
}
type Client interface {
	Call(...string) (Result, error)
	CheckKinds(Team) error
	Binary() string
}
type Herdr struct {
	Env []string
	Bin string
}

func (h *Herdr) Binary() string { return h.Bin }
func (h *Herdr) execute(args ...string) ([]byte, error) {
	timeout := 45 * time.Second
	if len(args) > 1 && args[0] == "agent" && args[1] == "prompt" {
		timeout = 130 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	return h.executeContext(ctx, args...)
}

// commandTarget includes only routing arguments, never prompt text or agent args.
func commandTarget(args []string) string {
	command := strings.Join(args[:min(2, len(args))], " ")
	if len(args) > 2 && !strings.HasPrefix(args[2], "--") {
		switch command {
		case "agent start", "agent get", "agent prompt", "agent focus", "agent wait", "pane get", "pane rename", "pane split":
			command += " " + args[2]
		}
	}
	return command
}

func responseError(data []byte) json.RawMessage {
	var envelope struct {
		Error json.RawMessage `json:"error"`
	}
	if json.Unmarshal(data, &envelope) == nil && len(envelope.Error) > 0 && string(bytes.TrimSpace(envelope.Error)) != "null" {
		return envelope.Error
	}
	return nil
}

func (h *Herdr) executeContext(ctx context.Context, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, h.Bin, args...)
	cmd.Env = h.Env
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	data, err := cmd.Output()
	if err != nil {
		var details []string
		if structured := responseError(data); structured != nil {
			details = append(details, "stdout error: "+string(structured))
		}
		if detail := strings.TrimSpace(stderr.String()); detail != "" {
			details = append(details, "stderr: "+detail)
		}
		if ctx.Err() != nil {
			details = append(details, ctx.Err().Error())
			err = errors.Join(err, ctx.Err())
		}
		return data, fmt.Errorf("Herdr %s: %s: %w", commandTarget(args), strings.Join(details, "; "), err)
	}
	return data, nil
}
func (h *Herdr) Call(args ...string) (Result, error) {
	data, err := h.execute(args...)
	if err != nil {
		return Result{}, err
	}
	return decodeHerdrResult(data, args...)
}

// CallContext allows callers with a total operation budget to bound the CLI
// subprocess too, rather than only the pauses between repeated calls.
func (h *Herdr) CallContext(ctx context.Context, args ...string) (Result, error) {
	data, err := h.executeContext(ctx, args...)
	if err != nil {
		return Result{}, err
	}
	return decodeHerdrResult(data, args...)
}

func decodeHerdrResult(data []byte, args ...string) (Result, error) {
	var envelope struct {
		Result *Result         `json:"result"`
		Error  json.RawMessage `json:"error"`
	}
	if err := json.Unmarshal(data, &envelope); err != nil {
		return Result{}, fmt.Errorf("invalid Herdr %s response: %w", commandTarget(args), err)
	}
	if structured := responseError(data); structured != nil {
		return Result{}, fmt.Errorf("Herdr %s error: %s", commandTarget(args), structured)
	}
	if envelope.Result == nil {
		return Result{}, fmt.Errorf("Herdr %s response is missing result", commandTarget(args))
	}
	return *envelope.Result, nil
}
func (h *Herdr) CheckKinds(team Team) error {
	data, err := h.execute("agent", "start", "--help")
	if err != nil {
		return err
	}
	supported, err := parseAgentKindsHelp(string(data))
	if err != nil {
		return fmt.Errorf("cannot read supported agent kinds from %s: %w; run %s agent start --help and check Herdr compatibility (requires 0.9.3+)", h.versionLabel(), err, shellQuote(h.Bin))
	}
	for _, member := range team.Members {
		if !supported[member.Kind] {
			return fmt.Errorf("%s does not support agent kind %q for member %q; supported kinds: %s; edit that member's kind or use a compatible Herdr version", h.versionLabel(), member.Kind, member.ID, strings.Join(sortedKinds(supported), ", "))
		}
	}
	return nil
}
func envMap(entries []string) map[string]string {
	values := map[string]string{}
	for _, entry := range entries {
		key, value, ok := strings.Cut(entry, "=")
		if ok {
			values[key] = value
		}
	}
	return values
}
func resolveProject(env map[string]string, client Client, explicit string) (string, string, error) {
	var invocation struct {
		WorkspaceID  string `json:"workspace_id"`
		WorkspaceCwd string `json:"workspace_cwd"`
		PaneID       string `json:"focused_pane_id"`
		PaneCwd      string `json:"focused_pane_cwd"`
		Worktree     *struct {
			Path string `json:"checkout_path"`
		} `json:"worktree"`
	}
	if raw := env["HERDR_PLUGIN_CONTEXT_JSON"]; raw != "" {
		if err := json.Unmarshal([]byte(raw), &invocation); err != nil {
			return "", "", fmt.Errorf("invalid plugin context: %w", err)
		}
	}
	workspace := invocation.WorkspaceID
	if workspace == "" {
		workspace = env["HERDR_WORKSPACE_ID"]
	}
	if workspace == "" {
		return "", "", errors.New("no current Herdr workspace; invoke the action from a project workspace")
	}
	candidate := explicit
	if candidate == "" && invocation.Worktree != nil {
		candidate = invocation.Worktree.Path
	}
	if candidate == "" {
		candidate = invocation.WorkspaceCwd
	}
	if candidate == "" {
		candidate = invocation.PaneCwd
	}
	if candidate == "" {
		pane := invocation.PaneID
		if pane == "" {
			pane = env["HERDR_PANE_ID"]
		}
		if pane != "" {
			result, err := client.Call("pane", "get", pane)
			if err != nil {
				return "", "", err
			}
			candidate = result.Pane.Cwd
		}
	}
	if candidate == "" {
		return "", "", errors.New("cannot determine project directory; pass --project /absolute/project/path")
	}
	project, err := canonical(candidate)
	if err != nil {
		return "", "", err
	}
	info, err := os.Stat(project)
	if err != nil {
		return "", "", err
	}
	if !info.IsDir() {
		return "", "", errors.New("project path is not a directory")
	}
	return project, workspace, nil
}

type StartedMember struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	PaneID      string `json:"pane_id"`
	TerminalID  string `json:"terminal_id"`
	Kind        string `json:"kind"`
	Started     bool   `json:"started"`
	Initialized bool   `json:"initialized"`
}
type Startup struct {
	ConfigDigest string          `json:"config_digest,omitempty"`
	Stage        string          `json:"stage,omitempty"`
	Project      string          `json:"project"`
	WorkspaceID  string          `json:"workspace_id"`
	Status       string          `json:"status"`
	TabID        string          `json:"tab_id"`
	LeaderName   string          `json:"leader_name"`
	Members      []StartedMember `json:"members"`
	Error        string          `json:"error,omitempty"`
}

func save(path string, state Startup) error {
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	temp := path + ".tmp"
	if err = os.WriteFile(temp, append(data, '\n'), 0600); err != nil {
		return err
	}
	return os.Rename(temp, path)
}
func lock(path string) (func(), error) {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		file.Close()
		return nil, errors.New("team initialization is already running for this project")
	}
	return func() { _ = syscall.Flock(int(file.Fd()), syscall.LOCK_UN); file.Close() }, nil
}
func reuse(client Client, path, workspace string, out io.Writer, teams ...Team) (bool, error) {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	var state Startup
	if err = json.Unmarshal(data, &state); err != nil {
		return false, fmt.Errorf("invalid startup record %s: %w", path, err)
	}
	if len(state.Members) == 0 {
		return false, fmt.Errorf("previous initialization did not return pane IDs; inspect the workspace before removing record %s and retrying", path)
	}
	result, err := client.Call("agent", "list")
	if err != nil {
		return false, err
	}
	matched := map[string]Agent{}
	for _, member := range state.Members {
		for _, agent := range result.Agents {
			if agent.Name == member.Name && agent.TerminalID == member.TerminalID && agent.WorkspaceID == workspace && agent.Kind != "" {
				matched[member.Name] = agent
			}
		}
	}
	if state.Status == "ready" && len(matched) == len(state.Members) {
		leader, ok := matched[state.LeaderName]
		if !ok {
			return false, errors.New("startup record has no matching leader")
		}
		if len(teams) > 0 {
			reportConfigChange(out, state, teams[0])
		}
		if err = focusReadyTeam(client, leader.Name, path, out); err != nil {
			return false, err
		}
		fmt.Fprintf(out, "Existing team focused: %s\n", leader.Name)
		return true, nil
	}
	panes, err := client.Call("pane", "list", "--workspace", workspace)
	if err != nil {
		return false, err
	}
	for _, member := range state.Members {
		for _, pane := range panes.Panes {
			if pane.TerminalID == member.TerminalID {
				return false, fmt.Errorf("an incomplete or changed team still has live panes; inspect %s and close those team panes before restarting; no duplicate team was created", path)
			}
		}
	}
	return false, nil
}
func focusReadyTeam(client Client, name, path string, out io.Writer) error {
	if _, err := client.Call("agent", "focus", name); err != nil {
		fmt.Fprintf(out, "Team ready, but focusing %s failed. Startup record: %s\nRun initialization again to retry focusing the ready team.\n", name, path)
		return err
	}
	return nil
}

func shellQuote(text string) string { return "'" + strings.ReplaceAll(text, "'", "'\"'\"'") + "'" }
func rolePrompt(team Team, member Member, state Startup, binary string) string {
	var roster strings.Builder
	for _, entry := range state.Members {
		fmt.Fprintf(&roster, "- %s: %s (pane %s)\n", entry.ID, entry.Name, entry.PaneID)
	}
	cli := shellQuote(binary)
	common := fmt.Sprintf(`You are member %s of team %s.
Shared project/worktree: %s
Leader: %s
Team members (use these exact names with Herdr):
%s
Team instructions:
%s

Your role:
%s

All members share one worktree. Preserve existing changes and only edit assigned files.
Coordinate overlapping file changes and Git operations through the leader.
Use Herdr only when HERDR_ENV=1. Never target agents outside this roster.
Herdr commands:
%s agent get <name>
%s agent prompt <name> 'instructions' --wait --timeout 120000
%s agent wait <name> --timeout 120000
%s agent read <name> --source recent-unwrapped --lines 120
Use argv or proper shell quoting for prompts. Do not interpolate untrusted text into shell code.
idle/done mean a settled turn, not task success. Read the actual response.
If blocked, inspect the dialog and ask the user for approvals; do not automatically approve.
On timeout/stalled, inspect state and output before retrying: input may already have been sent.
`, member.ID, team.Name, state.Project, state.LeaderName, roster.String(), team.Instructions, member.Instructions, cli, cli, cli, cli)
	if member.ID == team.Leader {
		return common + `
You are the leader. Wait for the user's goal, then split and assign tasks.
For parallel work, prompt ready members without --wait first, then wait and read each.
Only send new tasks to idle/done, interactive-ready members. Never wait on yourself.
Confirm working has started after non-waiting submission: an immediately idle member may not have processed it.
Schedule overlapping file changes and dependent work sequentially.
Collect results using agent read, answer questions, arrange reviews and fixes, then run final verification.
Coordinate Git operations centrally. Do not create worktrees.
If a response is incomplete, ask the member to write a Markdown report and return its absolute path.
For initialization only, acknowledge the roster and wait for the user's goal; do not assign work yet.
`
	}
	return common + `
For initialization only, acknowledge your role and wait. Do not start editing.
When assigned work, report changes, checks and unresolved questions in your own conversation.
The leader reads your replies through Herdr; do not interrupt the leader with completion prompts.
`
}
func initializePrompt(client Client, entry StartedMember, workspace, prompt string) error {
	return initializePromptWithReadiness(client, entry, workspace, prompt, 30*time.Second, 250*time.Millisecond, nil)
}

// Poll only startup states: a working member may already be executing user work.
// Prompt delivery is attempted once, even if the CLI later reports a timeout.
func initializePromptWithReadiness(client Client, entry StartedMember, workspace, prompt string, timeout, interval time.Duration, progress func(string)) error {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	deadline, _ := ctx.Deadline()
	var agent Agent
	timedOut := func() error {
		return fmt.Errorf("%s readiness timed out after %s (status %s, interactive_ready %t); open its pane and check startup, login or permission prompts: %w", entry.Name, timeout, agent.Status, agent.InteractiveReady, context.DeadlineExceeded)
	}
	waiting := false
	for {
		if time.Until(deadline) <= 0 {
			return timedOut()
		}
		var current Result
		var err error
		if contextual, ok := client.(interface {
			CallContext(context.Context, ...string) (Result, error)
		}); ok {
			current, err = contextual.CallContext(ctx, "agent", "get", entry.Name)
		} else {
			current, err = client.Call("agent", "get", entry.Name)
		}
		// A readiness response arriving after the deadline must not authorize
		// prompt delivery, even if the client ignored context cancellation.
		if time.Until(deadline) <= 0 {
			return errors.Join(timedOut(), err)
		}
		if err != nil {
			return err
		}
		agent = current.Agent
		if agent.Name != entry.Name || agent.PaneID != entry.PaneID || agent.TerminalID != entry.TerminalID || agent.WorkspaceID != workspace || agent.Kind != entry.Kind {
			return fmt.Errorf("%s identity changed before initialization", entry.Name)
		}
		if (agent.Status == "idle" || agent.Status == "done") && agent.InteractiveReady {
			break
		}
		if agent.Status == "blocked" {
			return fmt.Errorf("%s needs user input before initialization; open its pane and check login or permission prompts", entry.Name)
		}
		switch agent.Status {
		case "starting", "initializing", "idle", "done":
		default:
			return fmt.Errorf("%s is not ready for initialization (status %s, interactive_ready %t)", entry.Name, agent.Status, agent.InteractiveReady)
		}
		if !waiting && progress != nil {
			progress("waiting for readiness")
		}
		waiting = true
		timer := time.NewTimer(min(interval, max(time.Until(deadline), 0)))
		select {
		case <-ctx.Done():
			timer.Stop()
			return timedOut()
		case <-timer.C:
		}
	}
	if progress != nil {
		progress("initializing role")
	}
	if time.Until(deadline) <= 0 {
		return timedOut()
	}
	// get and prompt are separate CLI calls. An external caller can still race
	// this check; --wait observes lifecycle states, not a uniquely identified turn.
	result, err := client.Call("agent", "prompt", entry.Name, prompt, "--wait", "--timeout", "120000")
	if err != nil {
		return err // Delivery may be uncertain: never resend automatically.
	}
	if result.Agent.Status != "idle" && result.Agent.Status != "done" {
		return fmt.Errorf("%s needs user input during initialization; open its pane and check login or permission prompts", entry.Name)
	}
	return nil
}

func initializeMembers(team Team, state *Startup, path string, client Client, outputs ...io.Writer) error {
	out := io.Discard
	if len(outputs) > 0 && outputs[0] != nil {
		out = outputs[0]
	}
	type task struct {
		index  int
		entry  StartedMember
		prompt string
	}
	type completion struct {
		index int
		stage string
		done  bool
		err   error
	}
	var tasks []task
	var leader task
	for i, member := range team.Members {
		job := task{i, state.Members[i], rolePrompt(team, member, *state, client.Binary())}
		if member.ID == team.Leader {
			leader = job
		} else {
			tasks = append(tasks, job)
		}
	}
	workspace := state.WorkspaceID
	results := make(chan completion, 4)
	next, active := 0, 0
	var failure error
	for next < len(tasks) || active > 0 {
		for failure == nil && next < len(tasks) && active < 4 {
			job := tasks[next]
			next++
			active++
			fmt.Fprintf(out, "%s: checking readiness…\n", job.entry.Name)
			go func() {
				err := initializePromptWithReadiness(client, job.entry, workspace, job.prompt, 30*time.Second, 250*time.Millisecond, func(stage string) {
					results <- completion{index: job.index, stage: stage}
				})
				results <- completion{index: job.index, done: true, err: err}
			}()
		}
		if active == 0 {
			break
		}
		result := <-results
		if !result.done {
			fmt.Fprintf(out, "%s: %s…\n", state.Members[result.index].Name, result.stage)
			continue
		}
		active--
		if result.err != nil {
			fmt.Fprintf(out, "%s: initialization failed: %v\n", state.Members[result.index].Name, result.err)
			failure = errors.Join(failure, fmt.Errorf("initializing %s: %w", state.Members[result.index].Name, result.err))
			continue
		}
		fmt.Fprintf(out, "%s: initialized\n", state.Members[result.index].Name)
		// Only this coordinator mutates state and writes records, including when
		// draining in-flight results after a failure. Unsent tasks stay untouched.
		state.Members[result.index].Initialized = true
		if err := save(path, *state); err != nil {
			failure = errors.Join(failure, err)
		}
	}
	if failure != nil {
		return failure
	}
	fmt.Fprintf(out, "%s: checking readiness…\n", leader.entry.Name)
	if err := initializePromptWithReadiness(client, leader.entry, workspace, leader.prompt, 30*time.Second, 250*time.Millisecond, func(stage string) {
		fmt.Fprintf(out, "%s: %s…\n", leader.entry.Name, stage)
	}); err != nil {
		fmt.Fprintf(out, "%s: initialization failed: %v\n", leader.entry.Name, err)
		return err
	}
	fmt.Fprintf(out, "%s: initialized\n", leader.entry.Name)
	state.Members[leader.index].Initialized = true
	return save(path, *state)
}

func initialize(team Team, project, workspace, stateDir string, env map[string]string, client Client, out io.Writer) (err error) {
	if err = os.MkdirAll(stateDir, 0700); err != nil {
		return err
	}
	path := startupPath(stateDir, project, workspace, env)
	unlock, err := lock(path + ".lock")
	if err != nil {
		return err
	}
	defer unlock()
	reused, err := reuse(client, path, workspace, out, team)
	if err != nil || reused {
		return err
	}
	if err = client.CheckKinds(team); err != nil {
		return err
	}
	var nonce [4]byte
	if _, err = rand.Read(nonce[:]); err != nil {
		return err
	}
	prefix := "t" + hex.EncodeToString(nonce[:])
	state := Startup{Project: project, WorkspaceID: workspace, Status: "starting", Stage: "creating panes", ConfigDigest: teamDigest(team), LeaderName: prefix + "-" + team.Leader}
	if err = save(path, state); err != nil {
		return err
	}
	readySaved := false
	defer func() {
		if err != nil && !readySaved {
			state.Status = "partial"
			state.Error = err.Error()
			if saveErr := save(path, state); saveErr != nil {
				err = fmt.Errorf("%w; cannot save partial record: %v", err, saveErr)
			}
			fmt.Fprintf(out, "Initialization stopped; panes were preserved. Startup record: %s\n", path)
		}
	}()
	created, err := client.Call("tab", "create", "--workspace", workspace, "--cwd", project, "--label", team.Name, "--no-focus")
	if err != nil {
		return err
	}
	state.TabID = created.Tab.ID
	pane := created.RootPane
	for index, member := range team.Members {
		if index > 0 {
			direction := "right"
			if index%2 == 0 {
				direction = "down"
			}
			split, callErr := client.Call("pane", "split", pane.PaneID, "--direction", direction, "--cwd", project, "--no-focus")
			if callErr != nil {
				return callErr
			}
			pane = split.Pane
		}
		if pane.PaneID == "" || pane.TerminalID == "" {
			return errors.New("Herdr creation response is missing pane identity")
		}
		state.Members = append(state.Members, StartedMember{ID: member.ID, Name: prefix + "-" + member.ID, PaneID: pane.PaneID, TerminalID: pane.TerminalID, Kind: member.Kind})
		if err = save(path, state); err != nil {
			return err
		}
		// Persist the pane identity before renaming so a failed rename keeps
		// the same partial-startup recovery guarantees as a failed agent start.
		if _, err = client.Call("pane", "rename", pane.PaneID, member.ID); err != nil {
			return err
		}
	}
	state.Stage = "starting agents"
	if err = save(path, state); err != nil {
		return err
	}
	for i, member := range team.Members {
		entry := &state.Members[i]
		fmt.Fprintf(out, "Starting %s (%s)…\n", entry.Name, member.Kind)
		args := []string{"agent", "start", entry.Name, "--kind", member.Kind, "--pane", entry.PaneID, "--"}
		args = append(args, member.Args...)
		if _, err = client.Call(args...); err != nil {
			return fmt.Errorf("starting %s (%s) in pane %s failed: %w; open that pane and check login, permissions and CLI startup; launch delivery may be uncertain, so no automatic restart was attempted", entry.Name, member.Kind, entry.PaneID, err)
		}
		entry.Started = true
		if err = save(path, state); err != nil {
			return err
		}
	}
	state.Stage = "initializing roles"
	if err = save(path, state); err != nil {
		return err
	}
	if err = initializeMembers(team, &state, path, client, out); err != nil {
		return err
	}
	state.Status = "ready"
	state.Stage = "ready"
	if err = save(path, state); err != nil {
		return err
	}
	readySaved = true
	if err = focusReadyTeam(client, state.LeaderName, path, out); err != nil {
		return err
	}
	fmt.Fprintf(out, "Team ready. Send your goal to %s. Startup record: %s\n", state.LeaderName, path)
	return nil
}
func run(args []string, entries []string, out io.Writer) error {
	flags := flag.NewFlagSet("herdr-team", flag.ContinueOnError)
	flags.SetOutput(out)
	projectFlag := flags.String("project", "", "override the current project directory")
	status := flags.Bool("status", false, "show recorded team startup and current member status without changing agents")
	check := flags.Bool("check", false, "validate team files only; use current project context inside Herdr")
	initTeam := flags.Bool("init", false, "create .team from a template; do not start agents")
	listTemplates := flags.Bool("list-templates", false, "list built-in and configured templates offline")
	template := flags.String("template", "development", "template name or directory (with team.md and members)")
	templatesDir := flags.String("templates-dir", "", "named templates directory (default: HERDR_TEAM_TEMPLATES_DIR)")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("unexpected positional arguments")
	}
	modes := 0
	for _, enabled := range []bool{*check, *initTeam, *listTemplates, *status} {
		if enabled {
			modes++
		}
	}
	if modes > 1 {
		return errors.New("--init, --check, --list-templates and --status are mutually exclusive")
	}
	var templateOption, directoryOption bool
	flags.Visit(func(f *flag.Flag) {
		if f.Name == "template" {
			templateOption = true
		}
		if f.Name == "templates-dir" {
			directoryOption = true
		}
	})
	if templateOption && !*initTeam {
		return errors.New("--template requires --init")
	}
	if directoryOption && !*initTeam && !*listTemplates {
		return errors.New("--templates-dir requires --init or --list-templates")
	}
	env := envMap(entries)
	directory := env["HERDR_TEAM_TEMPLATES_DIR"]
	if directoryOption {
		directory = *templatesDir
	}
	if *listTemplates {
		names, err := availableTemplateNames(directory)
		if err != nil {
			return err
		}
		for _, name := range names {
			fmt.Fprintln(out, name)
		}
		return nil
	}
	if *initTeam || *check {
		path := *projectFlag
		if path == "" && env["HERDR_ENV"] == "1" {
			binary := env["HERDR_BIN_PATH"]
			if binary == "" {
				binary = "herdr"
			}
			var err error
			path, _, err = resolveProject(env, &Herdr{Env: entries, Bin: binary}, "")
			if err != nil {
				return err
			}
		}
		if path == "" {
			path = "."
		}
		project, err := canonical(path)
		if err != nil {
			return err
		}
		if *check {
			team, err := loadTeam(project)
			if err != nil {
				return err
			}
			fmt.Fprintf(out, "Valid team: %s; leader=%s; members=%d\n", team.Name, team.Leader, len(team.Members))
			return nil
		}
		if err = initFromTemplate(project, *template, directory); err != nil {
			return err
		}
		fmt.Fprintf(out, "Created %s from template %s. Edit team.md and members/*.md to configure roles, kind and args.\n", filepath.Join(project, ".team"), *template)
		return nil
	}
	if env["HERDR_ENV"] != "1" {
		return errors.New("not running inside Herdr; invoke start-team or status-team from a Herdr project")
	}
	binary := env["HERDR_BIN_PATH"]
	if binary == "" {
		binary = "herdr"
	}
	client := &Herdr{Env: entries, Bin: binary}
	project, workspace, err := resolveProject(env, client, *projectFlag)
	if err != nil {
		return err
	}
	stateDir, err := startupDirectory(env)
	if err != nil {
		return err
	}
	if *status {
		return reportStatus(client, startupPath(stateDir, project, workspace, env), project, workspace, out)
	}
	team, err := loadTeam(project)
	if err != nil {
		return err
	}
	return initialize(team, project, workspace, stateDir, env, client, out)
}
func main() {
	if err := run(os.Args[1:], os.Environ(), os.Stdout); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return
		}
		fmt.Fprintf(os.Stderr, "herdr-team: %v\n", err)
		os.Exit(1)
	}
}
