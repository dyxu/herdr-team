package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeHerdr struct {
	mu          sync.Mutex
	Calls       [][]string
	Panes       []Pane
	Agents      []Agent
	FailStart   string
	BlockPrompt bool
	FailTab     bool
	FailRename  string
	FailFocus   bool
	GetAgent    func(Agent) Agent
	Prompt      func(string) (Result, error)
}

func (f *fakeHerdr) Binary() string        { return "/path with spaces/herdr" }
func (f *fakeHerdr) CheckKinds(Team) error { return nil }
func (f *fakeHerdr) Call(args ...string) (Result, error) {
	f.mu.Lock()
	if len(args) > 1 && args[0] == "agent" && args[1] == "prompt" && f.Prompt != nil {
		f.Calls = append(f.Calls, append([]string(nil), args...))
		hook := f.Prompt
		f.mu.Unlock()
		return hook(args[2])
	}
	defer f.mu.Unlock()
	f.Calls = append(f.Calls, append([]string(nil), args...))
	command := strings.Join(args[:2], " ")
	switch command {
	case "agent list":
		return Result{Agents: append([]Agent(nil), f.Agents...)}, nil
	case "agent get":
		for _, agent := range f.Agents {
			if agent.Name == args[2] {
				if f.GetAgent != nil {
					agent = f.GetAgent(agent)
				}
				return Result{Agent: agent}, nil
			}
		}
		return Result{}, errors.New("agent not found")
	case "pane list":
		return Result{Panes: append([]Pane(nil), f.Panes...)}, nil
	case "pane rename":
		if args[2] == f.FailRename {
			return Result{}, errors.New("pane rename failed; delivery uncertain")
		}
		return Result{}, nil
	case "tab create", "pane split":
		if f.FailTab {
			return Result{}, errors.New("timeout; delivery uncertain")
		}
		id := string(rune('1' + len(f.Panes)))
		pane := Pane{PaneID: "w1:p" + id, TerminalID: "term-" + id}
		f.Panes = append(f.Panes, pane)
		result := Result{Pane: pane, RootPane: pane}
		result.Tab.ID = "w1:t2"
		return result, nil
	case "agent start":
		if f.FailStart != "" && strings.HasSuffix(args[2], f.FailStart) {
			return Result{}, errors.New("agent_not_ready")
		}
		var paneID string
		for i, arg := range args {
			if arg == "--pane" {
				paneID = args[i+1]
			}
		}
		for _, pane := range f.Panes {
			if pane.PaneID == paneID {
				f.Agents = append(f.Agents, Agent{Name: args[2], PaneID: paneID, TerminalID: pane.TerminalID, WorkspaceID: "w1", Kind: "any-kind", Status: "idle", InteractiveReady: true})
			}
		}
		return Result{}, nil
	case "agent prompt":
		status := "done"
		if f.BlockPrompt {
			status = "blocked"
		}
		return Result{Agent: Agent{Status: status}}, nil
	case "agent focus":
		if f.FailFocus {
			return Result{}, errors.New("focus failed")
		}
		return Result{}, nil
	default:
		return Result{}, errors.New("unexpected command: " + command)
	}
}
func write(t *testing.T, path, text string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(text), 0600); err != nil {
		t.Fatal(err)
	}
}
func fixture(t *testing.T) (string, string, Team) {
	t.Helper()
	root := t.TempDir()
	project := filepath.Join(root, "project with spaces")
	directory := filepath.Join(project, ".team", "members")
	if err := os.MkdirAll(directory, 0700); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(project, ".team", "TEAM.md"), "---\nname: development\nleader: leader\nmembers:\n  - members/leader.md\n  - members/dev.md\n---\nShared rules")
	for _, id := range []string{"leader", "dev"} {
		write(t, filepath.Join(directory, id+".md"), "---\nid: "+id+"\nkind: any-kind\nargs: ['--model', 'a b']\n---\nRole for "+id)
	}
	project, err := canonical(project)
	if err != nil {
		t.Fatal(err)
	}
	team, err := loadTeam(project)
	if err != nil {
		t.Fatal(err)
	}
	return project, filepath.Join(root, "state"), team
}
func startup(t *testing.T, directory string) Startup {
	t.Helper()
	paths, err := filepath.Glob(filepath.Join(directory, "*.json"))
	if err != nil || len(paths) != 1 {
		t.Fatalf("startup paths: %v, %v", paths, err)
	}
	data, err := os.ReadFile(paths[0])
	if err != nil {
		t.Fatal(err)
	}
	var state Startup
	if err = json.Unmarshal(data, &state); err != nil {
		t.Fatal(err)
	}
	return state
}
func start(t *testing.T, team Team, project, state string, client *fakeHerdr) error {
	t.Helper()
	return initialize(team, project, "w1", state, map[string]string{"HERDR_SOCKET_PATH": "/socket"}, client, &bytes.Buffer{})
}
func TestInitializeSharedWorktree(t *testing.T) {
	project, state, team := fixture(t)
	client := &fakeHerdr{}
	if err := start(t, team, project, state, client); err != nil {
		t.Fatal(err)
	}
	record := startup(t, state)
	if record.Status != "ready" {
		t.Fatal(record)
	}
	var prompts, starts [][]string
	for _, call := range client.Calls {
		switch strings.Join(call[:2], " ") {
		case "tab create", "pane split":
			for i, arg := range call {
				if arg == "--cwd" && call[i+1] != project {
					t.Fatalf("wrong cwd: %v", call)
				}
			}
			if !strings.Contains(strings.Join(call, " "), "--no-focus") {
				t.Fatal("background focus changed")
			}
		case "agent prompt":
			prompts = append(prompts, call)
		case "agent start":
			starts = append(starts, call)
		}
		if call[0] == "worktree" || call[0] == "git" {
			t.Fatal("unexpected workspace mutation")
		}
	}
	if len(starts) != 2 || len(prompts) != 2 {
		t.Fatal("members were not initialized")
	}
	if strings.Join(starts[0][len(starts[0])-3:], "|") != "--|--model|a b" {
		t.Fatal(starts[0])
	}
	if !strings.HasSuffix(prompts[1][2], "-leader") {
		t.Fatal("leader was not initialized last")
	}
	for _, value := range []string{"Shared rules", "Role for dev", record.LeaderName, project, "'/path with spaces/herdr' agent"} {
		if !strings.Contains(prompts[0][3], value) {
			t.Fatalf("prompt missing %q", value)
		}
	}
	last := client.Calls[len(client.Calls)-1]
	if strings.Join(last, " ") != "agent focus "+record.LeaderName {
		t.Fatal(last)
	}
}
func TestInitializeNamesRootAndSplitPanes(t *testing.T) {
	project, state, team := fixture(t)
	client := &fakeHerdr{}
	if err := start(t, team, project, state, client); err != nil {
		t.Fatal(err)
	}
	record := startup(t, state)
	if len(record.Members) != 2 || record.Members[0].Name != record.LeaderName {
		t.Fatal(record)
	}
	var renamed int
	for i, call := range client.Calls {
		switch strings.Join(call[:2], " ") {
		case "pane rename":
			if renamed >= len(record.Members) {
				t.Fatalf("unexpected rename: %v", call)
			}
			member := record.Members[renamed]
			if len(call) != 4 || call[2] != member.PaneID || call[3] != member.Name {
				t.Fatalf("rename must use the returned pane ID and full agent name: %v", call)
			}
			if !strings.HasPrefix(member.Name, "t") || member.Name == member.ID || !strings.HasSuffix(member.Name, "-"+member.ID) {
				t.Fatalf("missing team instance prefix: %s", member.Name)
			}
			creation := "tab create"
			if renamed > 0 {
				creation = "pane split"
			}
			if i == 0 || strings.Join(client.Calls[i-1][:2], " ") != creation {
				t.Fatalf("rename did not follow %s: %v", creation, client.Calls)
			}
			renamed++
		case "agent start":
			if renamed != len(record.Members) {
				t.Fatal("agent started before all panes were named")
			}
		}
	}
	if renamed != len(record.Members) {
		t.Fatalf("renamed %d panes, want %d", renamed, len(record.Members))
	}
}

func TestRenameFailurePreservesPartialStartup(t *testing.T) {
	for _, test := range []struct {
		name    string
		paneID  string
		members int
	}{
		{name: "leader root pane", paneID: "w1:p1", members: 1},
		{name: "member split pane", paneID: "w1:p2", members: 2},
	} {
		t.Run(test.name, func(t *testing.T) {
			project, state, team := fixture(t)
			client := &fakeHerdr{FailRename: test.paneID}
			err := start(t, team, project, state, client)
			if err == nil || !strings.Contains(err.Error(), "pane rename failed") {
				t.Fatalf("expected rename failure, got %v", err)
			}
			record := startup(t, state)
			if record.Status != "partial" || record.Error != err.Error() || record.TabID != "w1:t2" || len(record.Members) != test.members {
				t.Fatal(record)
			}
			if len(client.Panes) != test.members || len(client.Agents) != 0 {
				t.Fatalf("panes were not preserved or agents started: %+v", client)
			}
			for i, member := range record.Members {
				if member.PaneID != client.Panes[i].PaneID || member.TerminalID != client.Panes[i].TerminalID || member.Started || member.Initialized {
					t.Fatalf("incorrect partial member identity/state: %+v", member)
				}
			}
			client.Calls = nil
			client.FailRename = ""
			if err := start(t, team, project, state, client); err == nil || !strings.Contains(err.Error(), "no duplicate") {
				t.Fatalf("live partial team should block retry, got %v", err)
			}
			if len(client.Calls) != 2 || strings.Join(client.Calls[0], " ") != "agent list" || strings.Join(client.Calls[1], " ") != "pane list --workspace w1" {
				t.Fatalf("retry mutated live partial team: %v", client.Calls)
			}
			client.Panes = nil
			if err := start(t, team, project, state, client); err != nil {
				t.Fatalf("restart after panes closed failed: %v", err)
			}
			if restarted := startup(t, state); restarted.Status != "ready" || restarted.LeaderName == record.LeaderName {
				t.Fatalf("restart should create a ready team with a new prefix: %+v", restarted)
			}
		})
	}
}

func TestDuplicateInitializationFocusesExistingLeader(t *testing.T) {
	project, state, team := fixture(t)
	client := &fakeHerdr{}
	if err := start(t, team, project, state, client); err != nil {
		t.Fatal(err)
	}
	client.Calls = nil
	if err := start(t, team, project, state, client); err != nil {
		t.Fatal(err)
	}
	if len(client.Calls) != 2 || client.Calls[1][1] != "focus" {
		t.Fatal(client.Calls)
	}
}
func TestPartialStartPreventsDuplicate(t *testing.T) {
	project, state, team := fixture(t)
	client := &fakeHerdr{FailStart: "-dev"}
	if err := start(t, team, project, state, client); err == nil {
		t.Fatal("expected error")
	}
	record := startup(t, state)
	if record.Status != "partial" || len(record.Members) != 2 || !record.Members[0].Started {
		t.Fatal(record)
	}
	client.Calls = nil
	if err := start(t, team, project, state, client); err == nil || !strings.Contains(err.Error(), "no duplicate") {
		t.Fatal(err)
	}
	for _, call := range client.Calls {
		if call[0] == "tab" {
			t.Fatal("duplicate tab")
		}
	}
}
func TestBlockedInitialization(t *testing.T) {
	project, state, team := fixture(t)
	client := &fakeHerdr{BlockPrompt: true}
	if err := start(t, team, project, state, client); err == nil || !strings.Contains(err.Error(), "needs user input") {
		t.Fatal(err)
	}
	if startup(t, state).Status != "partial" {
		t.Fatal("blocked team marked ready")
	}
}
func TestReplacedAgentNotReused(t *testing.T) {
	project, state, team := fixture(t)
	client := &fakeHerdr{}
	if err := start(t, team, project, state, client); err != nil {
		t.Fatal(err)
	}
	client.Agents[0].TerminalID = "different"
	if err := start(t, team, project, state, client); err == nil || !strings.Contains(err.Error(), "changed team") {
		t.Fatal(err)
	}
}
func TestClosedTeamCanRestart(t *testing.T) {
	project, state, team := fixture(t)
	client := &fakeHerdr{}
	if err := start(t, team, project, state, client); err != nil {
		t.Fatal(err)
	}
	first := startup(t, state).LeaderName
	client.Panes = nil
	client.Agents = nil
	if err := start(t, team, project, state, client); err != nil {
		t.Fatal(err)
	}
	if startup(t, state).LeaderName == first {
		t.Fatal("name reused")
	}
}
func TestUncertainTabCreationNotRetried(t *testing.T) {
	project, state, team := fixture(t)
	client := &fakeHerdr{FailTab: true}
	if err := start(t, team, project, state, client); err == nil {
		t.Fatal("expected timeout")
	}
	client.Calls = nil
	if err := start(t, team, project, state, client); err == nil || !strings.Contains(err.Error(), "did not return pane IDs") {
		t.Fatal(err)
	}
	if len(client.Calls) != 0 {
		t.Fatal(client.Calls)
	}
}
func TestInvalidDefinitions(t *testing.T) {
	cases := []struct{ name, file, from, to string }{
		{"leader missing", "TEAM.md", "leader: leader", "leader: missing"},
		{"duplicate ID", "members/dev.md", "id: dev", "id: leader"},
		{"duplicate key", "TEAM.md", "name: development", "name: development\nname: other"},
		{"unknown field", "members/dev.md", "id: dev", "id: dev\nextra: value"},
		{"invalid args", "members/dev.md", "['--model', 'a b']", "[123]"},
		{"invalid path", "TEAM.md", "members/dev.md", "../outside.md"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			project, _, _ := fixture(t)
			path := filepath.Join(project, ".team", test.file)
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if test.name == "invalid path" {
				write(t, filepath.Join(project, "outside.md"), "---\nid: outside\nkind: any-kind\n---\n")
			}
			write(t, path, strings.Replace(string(data), test.from, test.to, 1))
			if _, err := loadTeam(project); err == nil {
				t.Fatal("invalid definition accepted")
			}
		})
	}
}
func TestSymlinkMemberEscape(t *testing.T) {
	project, _, _ := fixture(t)
	outside := filepath.Join(t.TempDir(), "member.md")
	write(t, outside, "---\nid: dev\nkind: any-kind\n---\n")
	path := filepath.Join(project, ".team", "members", "dev.md")
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, path); err != nil {
		t.Fatal(err)
	}
	if _, err := loadTeam(project); err == nil {
		t.Fatal("symlink escape accepted")
	}
}
func TestProjectContext(t *testing.T) {
	project, _, _ := fixture(t)
	for _, invocation := range []map[string]any{
		{"workspace_id": "w1", "workspace_cwd": project, "focused_pane_cwd": "/wrong-subfolder"},
		{"workspace_id": "w1", "worktree": map[string]string{"checkout_path": project}},
	} {
		raw, _ := json.Marshal(invocation)
		path, workspace, err := resolveProject(map[string]string{"HERDR_PLUGIN_CONTEXT_JSON": string(raw)}, &fakeHerdr{}, "")
		if err != nil || path != project || workspace != "w1" {
			t.Fatalf("%s %s %v", path, workspace, err)
		}
	}
}
func TestOutsideHerdrAndOfflineCheck(t *testing.T) {
	project, _, _ := fixture(t)
	if err := run([]string{"--project", project}, nil, &bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), "not running inside Herdr") {
		t.Fatal(err)
	}
	if err := run([]string{"--check", "--project", project}, nil, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
}
func TestInitializationLock(t *testing.T) {
	path := filepath.Join(t.TempDir(), "startup.lock")
	release, err := lock(path)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	if second, err := lock(path); err == nil {
		second()
		t.Fatal("second lock succeeded")
	}
}
func TestHerdrArgumentsAreLiteral(t *testing.T) {
	root := t.TempDir()
	binary := filepath.Join(root, "fake herdr")
	capture := filepath.Join(root, "args")
	unwanted := filepath.Join(root, "unwanted")
	write(t, binary, "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$CAPTURE\"\nprintf '{\"result\":{}}\\n'\n")
	if err := os.Chmod(binary, 0700); err != nil {
		t.Fatal(err)
	}
	client := &Herdr{Bin: binary, Env: append(os.Environ(), "CAPTURE="+capture)}
	literal := "hello $(touch " + unwanted + ") `danger`\nnext line"
	if _, err := client.Call("agent", "prompt", "target", literal); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(capture)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "agent\nprompt\ntarget\n"+literal+"\n" {
		t.Fatalf("modified argv: %s", data)
	}
	if _, err := os.Stat(unwanted); !os.IsNotExist(err) {
		t.Fatal("shell interpolation executed")
	}
}

func TestFocusFailureKeepsReadyAndRetriesOnlyFocus(t *testing.T) {
	project, directory, team := fixture(t)
	client := &fakeHerdr{FailFocus: true}
	var out bytes.Buffer
	invoke := func() error {
		out.Reset()
		return initialize(team, project, "w1", directory, map[string]string{"HERDR_SOCKET_PATH": "/socket"}, client, &out)
	}
	if err := invoke(); err == nil || !strings.Contains(err.Error(), "focus failed") {
		t.Fatal(err)
	}
	paths, err := filepath.Glob(filepath.Join(directory, "*.json"))
	if err != nil || len(paths) != 1 || !filepath.IsAbs(paths[0]) {
		t.Fatalf("expected an absolute startup record path: %v, %v", paths, err)
	}
	checkOutput := func() {
		t.Helper()
		for _, text := range []string{"Team ready", "Startup record: " + paths[0], "Run initialization again to retry focusing the ready team."} {
			if !strings.Contains(out.String(), text) {
				t.Fatalf("focus failure output missing %q: %s", text, out.String())
			}
		}
		if strings.Contains(out.String(), "Initialization stopped") {
			t.Fatalf("ready team reported as partial: %s", out.String())
		}
	}
	checkOutput()
	record := startup(t, directory)
	if record.Status != "ready" || record.Error != "" {
		t.Fatal(record)
	}
	for _, member := range record.Members {
		if !member.Initialized {
			t.Fatal(member)
		}
	}
	client.Calls = nil
	if err := invoke(); err == nil || !strings.Contains(err.Error(), "focus failed") {
		t.Fatalf("expected retry focus failure, got %v", err)
	}
	checkOutput()
	if startup(t, directory).Status != "ready" {
		t.Fatal("retry downgraded record")
	}
	client.FailFocus = false
	client.Calls = nil
	if err := start(t, team, project, directory, client); err != nil {
		t.Fatal(err)
	}
	if len(client.Calls) != 2 || strings.Join(client.Calls[0], " ") != "agent list" || strings.Join(client.Calls[1], " ") != "agent focus "+record.LeaderName {
		t.Fatal(client.Calls)
	}
}

func TestInitializationRejectsUnsafeAgentBeforePrompt(t *testing.T) {
	for _, test := range []struct {
		name   string
		change func(Agent) Agent
	}{
		{"busy", func(a Agent) Agent { a.Status = "working"; return a }},
		{"blocked", func(a Agent) Agent { a.Status = "blocked"; return a }},
		{"unknown", func(a Agent) Agent { a.Status = "unknown"; return a }},
		{"not ready", func(a Agent) Agent { a.InteractiveReady = false; return a }},
		{"name replaced", func(a Agent) Agent { a.Name = "replacement"; return a }},
		{"pane replaced", func(a Agent) Agent { a.PaneID = "w1:p99"; return a }},
		{"terminal replaced", func(a Agent) Agent { a.TerminalID = "other"; return a }},
		{"workspace replaced", func(a Agent) Agent { a.WorkspaceID = "w99"; return a }},
		{"kind replaced", func(a Agent) Agent { a.Kind = "other"; return a }},
	} {
		t.Run(test.name, func(t *testing.T) {
			project, directory, team := fixture(t)
			client := &fakeHerdr{GetAgent: test.change}
			if err := start(t, team, project, directory, client); err == nil {
				t.Fatal("unsafe agent accepted")
			}
			for _, call := range client.Calls {
				if call[0] == "agent" && call[1] == "prompt" {
					t.Fatal("prompt submitted", call)
				}
			}
			if startup(t, directory).Status != "partial" {
				t.Fatal("expected partial")
			}
		})
	}
	t.Run("leader checked after ordinary members", func(t *testing.T) {
		project, directory, team := fixture(t)
		client := &fakeHerdr{GetAgent: func(a Agent) Agent {
			if strings.HasSuffix(a.Name, "-leader") {
				a.Status = "working"
			}
			return a
		}}
		if err := start(t, team, project, directory, client); err == nil {
			t.Fatal("busy leader accepted")
		}
		record := startup(t, directory)
		if record.Members[0].Initialized || !record.Members[1].Initialized {
			t.Fatal(record)
		}
		for _, call := range client.Calls {
			if call[0] == "agent" && call[1] == "prompt" && strings.HasSuffix(call[2], "-leader") {
				t.Fatal("busy leader prompted")
			}
		}
	})
	t.Run("done and interactive ready accepted", func(t *testing.T) {
		project, directory, team := fixture(t)
		client := &fakeHerdr{GetAgent: func(a Agent) Agent { a.Status = "done"; return a }}
		if err := start(t, team, project, directory, client); err != nil {
			t.Fatal(err)
		}
	})
}

func testExecutable(t *testing.T, body string) *Herdr {
	t.Helper()
	path := filepath.Join(t.TempDir(), "herdr")
	write(t, path, "#!/bin/sh\n"+body)
	if err := os.Chmod(path, 0700); err != nil {
		t.Fatal(err)
	}
	return &Herdr{Bin: path, Env: os.Environ()}
}

func TestHerdrNonzeroStructuredErrorAndNull(t *testing.T) {
	client := testExecutable(t, "printf '%s\\n' '{\"error\":{\"code\":\"agent_prompt_stalled\",\"message\":\"delivery uncertain\"}}'\nprintf '%s\\n' 'stderr details' >&2\nexit 7\n")
	for _, command := range []string{"prompt", "start"} {
		_, err := client.Call("agent", command, "full-target", "secret-prompt-or-args")
		if err == nil {
			t.Fatal("expected failure")
		}
		for _, detail := range []string{"agent " + command + " full-target", "agent_prompt_stalled", "delivery uncertain", "stderr details", "exit status 7"} {
			if !strings.Contains(err.Error(), detail) {
				t.Fatalf("missing %q: %v", detail, err)
			}
		}
		if strings.Contains(err.Error(), "secret-prompt-or-args") {
			t.Fatal("sensitive command arguments leaked")
		}
	}
	client = testExecutable(t, "printf '%s\\n' '{\"result\":{},\"error\":null}'\n")
	if _, err := client.Call("agent", "get", "target"); err != nil {
		t.Fatal(err)
	}
}

func TestHerdrContextTimeoutDiagnostic(t *testing.T) {
	// exec avoids leaving a shell child holding the output pipes after timeout.
	client := testExecutable(t, "exec /bin/sleep 30\n")
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	_, err := client.executeContext(ctx, "agent", "prompt", "target", "secret")
	if !errors.Is(err, context.DeadlineExceeded) || !strings.Contains(err.Error(), "agent prompt target") || strings.Contains(err.Error(), "secret") {
		t.Fatal(err)
	}
}

func receiveName(t *testing.T, names <-chan string) string {
	t.Helper()
	select {
	case name := <-names:
		return name
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for controlled prompt")
		return ""
	}
}

func receiveCompletion(t *testing.T, done <-chan error) error {
	t.Helper()
	select {
	case err := <-done:
		return err
	case <-time.After(5 * time.Second):
		t.Fatal("initialization did not complete")
		return nil
	}
}

func TestParallelInitializationBoundAndLeaderLast(t *testing.T) {
	project, directory, team := fixture(t)
	for _, id := range []string{"two", "three", "four", "five"} {
		team.Members = append(team.Members, Member{ID: id, Kind: "any-kind"})
	}
	started := make(chan string, 6)
	gates := map[string]chan struct{}{}
	for _, member := range team.Members {
		gates[member.ID] = make(chan struct{})
	}
	var inFlightMu sync.Mutex
	inFlight, peak := 0, 0
	client := &fakeHerdr{Prompt: func(name string) (Result, error) {
		inFlightMu.Lock()
		inFlight++
		if inFlight > peak {
			peak = inFlight
		}
		inFlightMu.Unlock()
		defer func() {
			inFlightMu.Lock()
			inFlight--
			inFlightMu.Unlock()
		}()
		id := name[strings.Index(name, "-")+1:]
		started <- id
		<-gates[id]
		return Result{Agent: Agent{Status: "done"}}, nil
	}}
	done := make(chan error, 1)
	go func() { done <- start(t, team, project, directory, client) }()
	first := map[string]bool{}
	for i := 0; i < 4; i++ {
		id := receiveName(t, started)
		if id == "leader" || id == "five" || first[id] {
			t.Fatalf("unexpected initial prompt %s", id)
		}
		first[id] = true
	}
	// Keep all four initial requests gated throughout a short observation
	// window. Gates establish ordering; the timer only checks for extra work.
	select {
	case id := <-started:
		t.Fatalf("more than four concurrent prompts: %s", id)
	case <-time.After(100 * time.Millisecond):
	}
	inFlightMu.Lock()
	initialInFlight, initialPeak := inFlight, peak
	inFlightMu.Unlock()
	if initialInFlight != 4 || initialPeak != 4 {
		t.Fatalf("initial in-flight=%d, peak=%d; want four blocked requests", initialInFlight, initialPeak)
	}
	close(gates["dev"])
	if id := receiveName(t, started); id != "five" {
		t.Fatalf("want queued member, got %s", id)
	}
	if record := startup(t, directory); !record.Members[1].Initialized || record.Members[0].Initialized {
		t.Fatal(record)
	}
	for id := range first {
		if id != "dev" {
			close(gates[id])
		}
	}
	close(gates["five"])
	if id := receiveName(t, started); id != "leader" {
		t.Fatalf("leader not last: %s", id)
	}
	record := startup(t, directory)
	for _, member := range record.Members[1:] {
		if !member.Initialized {
			t.Fatalf("leader ran before result saved: %+v", member)
		}
	}
	close(gates["leader"])
	if err := receiveCompletion(t, done); err != nil {
		t.Fatal(err)
	}
	inFlightMu.Lock()
	finalInFlight, finalPeak := inFlight, peak
	inFlightMu.Unlock()
	if finalInFlight != 0 || finalPeak < 4 || finalPeak > 4 {
		t.Fatalf("final in-flight=%d, peak=%d; want zero in-flight and peak four", finalInFlight, finalPeak)
	}
}

type observedFailure struct {
	observed chan struct{}
	once     sync.Once
}

func (e *observedFailure) Error() string {
	e.once.Do(func() { close(e.observed) })
	return "timeout: prompt delivery uncertain"
}

func TestParallelFailureCollectsOtherMembersWithoutResending(t *testing.T) {
	project, directory, team := fixture(t)
	for _, id := range []string{"two", "three", "four", "five"} {
		team.Members = append(team.Members, Member{ID: id, Kind: "any-kind"})
	}
	started := make(chan string, 5)
	gates := map[string]chan struct{}{}
	for _, member := range team.Members {
		gates[member.ID] = make(chan struct{})
	}
	failure := &observedFailure{observed: make(chan struct{})}
	client := &fakeHerdr{Prompt: func(name string) (Result, error) {
		id := name[strings.Index(name, "-")+1:]
		started <- id
		<-gates[id]
		if id == "dev" {
			return Result{}, failure
		}
		return Result{Agent: Agent{Status: "done"}}, nil
	}}
	done := make(chan error, 1)
	go func() { done <- start(t, team, project, directory, client) }()
	for i := 0; i < 4; i++ {
		if id := receiveName(t, started); id == "leader" {
			t.Fatal("leader submitted early")
		}
	}
	close(gates["dev"])
	// Error formatting acknowledges that the coordinator has received the
	// failure. Other in-flight requests stay blocked until that acknowledgement.
	select {
	case <-failure.observed:
	case <-time.After(5 * time.Second):
		t.Fatal("coordinator did not observe failure")
	}
	for _, id := range []string{"two", "three", "four"} {
		close(gates[id])
	}
	if err := receiveCompletion(t, done); err == nil || !strings.Contains(err.Error(), "delivery uncertain") {
		t.Fatal(err)
	}
	record := startup(t, directory)
	if record.Status != "partial" || record.Members[0].Initialized || record.Members[1].Initialized {
		t.Fatal(record)
	}
	for _, member := range record.Members[2:5] {
		if !member.Initialized {
			t.Fatalf("lost in-flight success: %+v", member)
		}
	}
	if record.Members[5].Initialized {
		t.Fatal("unsent member initialized")
	}
	select {
	case id := <-started:
		t.Fatalf("unexpected extra prompt %s", id)
	default:
	}
	client.Calls = nil
	if err := start(t, team, project, directory, client); err == nil || !strings.Contains(err.Error(), "no duplicate") {
		t.Fatal(err)
	}
	for _, call := range client.Calls {
		if call[0] == "agent" && call[1] == "prompt" {
			t.Fatal("uncertain prompt resent")
		}
	}
}
