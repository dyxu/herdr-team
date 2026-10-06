package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type fakeHerdr struct {
	Calls       [][]string
	Panes       []Pane
	Agents      []Agent
	FailStart   string
	BlockPrompt bool
	FailTab     bool
	FailRename  string
}

func (f *fakeHerdr) Binary() string        { return "/path with spaces/herdr" }
func (f *fakeHerdr) CheckKinds(Team) error { return nil }
func (f *fakeHerdr) Call(args ...string) (Result, error) {
	f.Calls = append(f.Calls, append([]string(nil), args...))
	command := strings.Join(args[:2], " ")
	switch command {
	case "agent list":
		return Result{Agents: f.Agents}, nil
	case "pane list":
		return Result{Panes: f.Panes}, nil
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
				f.Agents = append(f.Agents, Agent{Name: args[2], PaneID: paneID, TerminalID: pane.TerminalID, WorkspaceID: "w1", Kind: "any-kind"})
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
