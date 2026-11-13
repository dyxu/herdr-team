package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type coreRequest struct {
	JSONRPC string         `json:"jsonrpc"`
	ID      int            `json:"id"`
	Method  string         `json:"method"`
	Params  map[string]any `json:"params"`
}

// Exercise hc connect's JSON-RPC transport in subprocesses, not the unrelated
// abbreviated run/ls CLI format. Real-core integration tests cover the server.
func TestCoreRPCServerHelper(t *testing.T) {
	root := os.Getenv("HERDR_TEAM_TEST_CORE")
	if root == "" {
		return
	}
	args := os.Args
	if args[len(args)-1] != "connect" {
		os.Exit(2)
	}
	var req coreRequest
	if json.NewDecoder(os.Stdin).Decode(&req) != nil || req.JSONRPC != "2.0" || req.ID != 1 {
		os.Exit(2)
	}
	log, _ := os.OpenFile(filepath.Join(root, "calls"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	_ = json.NewEncoder(log).Encode(req)
	_ = log.Close()
	emit := func(result any) {
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": result})
		os.Exit(0)
	}
	fail := func(kind, message string) {
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"jsonrpc": "2.0", "id": req.ID, "error": map[string]any{"code": -32000, "message": message, "data": map[string]string{"kind": kind, "hint": "read before retrying"}}})
		os.Exit(0)
	}
	path := filepath.Join(root, "terminals")
	data, _ := os.ReadFile(path)
	terminals := []coreTerminal{}
	_ = json.Unmarshal(data, &terminals)
	modeData, _ := os.ReadFile(filepath.Join(root, "mode"))
	mode := string(modeData)
	terminalID, _ := req.Params["terminal"].(string)
	switch req.Method {
	case "server.status":
		emit(map[string]any{"core": map[string]string{"id": "test-core"}})
	case "terminal.list":
		emit(map[string]any{"terminals": terminals})
	case "terminal.run":
		name, _ := req.Params["name"].(string)
		cwd, _ := req.Params["cwd"].(string)
		terminal := coreTerminal{Address: fmt.Sprintf("t%d", len(terminals)+1), Name: name, Cwd: cwd, State: "live", Labels: map[string]string{}}
		labels, _ := req.Params["labels"].(map[string]any)
		for k, v := range labels {
			terminal.Labels[k], _ = v.(string)
		}
		terminal.Status = &struct {
			State string `json:"state"`
		}{"idle"}
		if mode == "done" {
			terminal.Status.State = "done"
		}
		terminals = append(terminals, terminal)
		data, _ = json.Marshal(terminals)
		_ = os.WriteFile(path, data, 0600)
		if mode == "lost-launch" {
			fail("unavailable", "launch response lost")
		}
		emit(terminal)
	case "terminal.get":
		for _, terminal := range terminals {
			if terminal.Address == terminalID {
				emit(terminal)
			}
		}
		fail("not_found", "unknown terminal")
	case "terminal.wait":
		status := "idle"
		if mode == "done" {
			status = "done"
		}
		ended, reason := true, "status"
		if mode == "blocked" {
			status = "blocked"
		}
		marker := filepath.Join(root, "sent-"+terminalID)
		if _, err := os.Stat(marker); err == nil {
			status = "done"
			if mode == "message" || mode == "check-in" {
				once := filepath.Join(root, "interrupted-"+terminalID)
				if _, err := os.Stat(once); os.IsNotExist(err) {
					_ = os.WriteFile(once, nil, 0600)
					ended = false
					reason = "message"
					if mode == "check-in" {
						reason = "timeout"
					}
				}
			}
			if mode == "timeout" {
				time.Sleep(5 * time.Millisecond)
				ended = false
				reason = "timeout"
			}
		}
		emit(coreWait{Terminal: terminalID, Ended: ended, Reason: reason, Status: status, Turn: 1})
	case "terminal.send":
		if mode == "send-failure" {
			fail("unavailable", "delivery uncertain")
		}
		_ = os.WriteFile(filepath.Join(root, "sent-"+terminalID), nil, 0600)
		// started:false must not be mistaken for failure or a reason to resend.
		emit(map[string]any{"turn": 0, "started": false})
	}
	os.Exit(2)
}
func coreFixture(t *testing.T) (string, string, []string) {
	t.Helper()
	root := t.TempDir()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(root, "herdr-core")
	write(t, bin, "#!/bin/sh\nexec "+shellQuote(executable)+" -test.run=^TestCoreRPCServerHelper$ -- \"$@\"\n")
	if err = os.Chmod(bin, 0700); err != nil {
		t.Fatal(err)
	}
	project, _, _ := fixture(t)
	for _, id := range []string{"leader", "dev"} {
		write(t, filepath.Join(project, ".team", "members", id+".md"), "---\nid: "+id+"\nkind: codex\nargs: []\n---\nRole for "+id)
	}
	entries := append(os.Environ(), "HERDR_TEAM_TEST_CORE="+root, "HERDR_CORE_BIN_PATH="+bin, "HERDR_PLUGIN_STATE_DIR="+filepath.Join(root, "state"), "GORACE="+os.Getenv("GORACE")+" atexit_sleep_ms=0")
	return project, root, entries
}
func coreCalls(t *testing.T, root string) []coreRequest {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(root, "calls"))
	if err != nil {
		t.Fatal(err)
	}
	if len(bytes.TrimSpace(data)) == 0 {
		return nil
	}
	var calls []coreRequest
	for _, line := range bytes.Split(bytes.TrimSpace(data), []byte("\n")) {
		var req coreRequest
		if err = json.Unmarshal(line, &req); err != nil {
			t.Fatal(err)
		}
		calls = append(calls, req)
	}
	return calls
}
func countCoreCalls(calls []coreRequest, method string) int {
	n := 0
	for _, r := range calls {
		if r.Method == method {
			n++
		}
	}
	return n
}
func TestCoreLifecycle(t *testing.T) {
	for _, mode := range []string{"idle", "done", "message", "check-in"} {
		t.Run(mode, func(t *testing.T) {
			project, root, entries := coreFixture(t)
			write(t, filepath.Join(root, "mode"), mode)
			var out bytes.Buffer
			if err := run([]string{"--backend", "core", "--project", project}, entries, &out); err != nil {
				t.Fatal(err, out.String())
			}
			if !strings.Contains(out.String(), "attach") {
				t.Fatal(out.String())
			}
			calls := coreCalls(t, root)
			checkCoreContract(t, calls)
			caller := ""
			for _, req := range calls {
				switch req.Method {
				case "terminal.run":
					argv, _ := req.Params["argv"].([]any)
					if len(argv) != 3 || argv[0] != "/usr/bin/env" || argv[1] != "codex" || argv[2] != "--no-daemon" || req.Params["wait"] != false || req.Params["no_parent"] != true {
						t.Fatalf("incorrect run params: %v", req.Params)
					}
				case "terminal.send":
					prompt, _ := req.Params["text"].(string)
					if !strings.Contains(prompt, "herdr-core") || strings.Contains(prompt, " agent prompt ") || !strings.Contains(prompt, "terminal t1") {
						t.Fatal("incorrect core roster/prompt", prompt)
					}
					if mode == "done" {
						if _, ok := req.Params["if"]; ok {
							t.Fatal("done is not a legal conditional status")
						}
					} else if req.Params["if"] != "idle" {
						t.Fatal("missing idle guard")
					}
					if req.Params["force"] != false {
						t.Fatal("force enabled")
					}
					fallthrough
				case "terminal.wait":
					value, _ := req.Params["caller"].(string)
					if caller == "" {
						caller = value
					}
					if caller == "" || value != caller {
						t.Fatal("caller changed between send/wait calls")
					}
				}
			}
			if countCoreCalls(calls, "terminal.send") != 2 {
				t.Fatal("role was resent")
			}
			if mode == "message" && !strings.Contains(out.String(), "continuing the same turn") {
				t.Fatal(out.String())
			}
			out.Reset()
			if err := run([]string{"--backend", "core", "--status", "--project", project}, entries, &out); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(out.String(), "Team startup: ready") || !strings.Contains(out.String(), modeStatus(mode)) {
				t.Fatal(out.String())
			}
			write(t, filepath.Join(project, ".team", "members", "dev.md"), "---\nid: dev\nkind: codex\n---\nchanged role\n")
			out.Reset()
			if err := run([]string{"--backend", "core", "--project", project}, entries, &out); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(out.String(), "Configuration changed") {
				t.Fatal(out.String())
			}
			after := coreCalls(t, root)
			if countCoreCalls(after, "terminal.run") != countCoreCalls(calls, "terminal.run") || countCoreCalls(after, "terminal.send") != 2 {
				t.Fatal("reuse/status launched or resent")
			}
		})
	}
}
func modeStatus(mode string) string {
	if mode == "done" {
		return "done"
	}
	return "idle"
}
func TestCorePartialStartupDoesNotResend(t *testing.T) {
	for _, mode := range []string{"blocked", "lost-launch", "send-failure"} {
		t.Run(mode, func(t *testing.T) {
			project, root, entries := coreFixture(t)
			write(t, filepath.Join(root, "mode"), mode)
			args := []string{"--backend", "core", "--project", project}
			if err := run(args, entries, &bytes.Buffer{}); err == nil {
				t.Fatal("accepted failed initialization")
			}
			before := coreCalls(t, root)
			if mode == "blocked" && countCoreCalls(before, "terminal.send") != 0 {
				t.Fatal("sent to blocked terminal")
			}
			if err := run(args, entries, &bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), "incomplete") {
				t.Fatalf("did not guard partial startup: %v", err)
			}
			after := coreCalls(t, root)
			if countCoreCalls(after, "terminal.run") != countCoreCalls(before, "terminal.run") || countCoreCalls(after, "terminal.send") != countCoreCalls(before, "terminal.send") {
				t.Fatal("partial startup relaunched or resent")
			}
		})
	}
}
func TestCoreWaitBudget(t *testing.T) {
	_, root, entries := coreFixture(t)
	write(t, filepath.Join(root, "mode"), "timeout")
	write(t, filepath.Join(root, "sent-t1"), "")
	write(t, filepath.Join(root, "calls"), "")
	c := &Core{Herdr{Bin: envMap(entries)["HERDR_CORE_BIN_PATH"], Env: entries}}
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	if err := c.waitSettled(ctx, "t1", &bytes.Buffer{}); err == nil {
		t.Fatal("unbounded wait")
	}
	if countCoreCalls(coreCalls(t, root), "terminal.send") != 0 {
		t.Fatal("wait resent prompt")
	}
}
func TestCoreSelectionAndOfflineModes(t *testing.T) {
	project, root, entries := coreFixture(t)
	entries = append(entries, "HERDR_ENV=0", "HC_TERMINAL_ID=t99")
	if err := run([]string{"--project", project}, entries, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	if countCoreCalls(coreCalls(t, root), "terminal.run") == 0 {
		t.Fatal("auto did not select core")
	}
	if err := run([]string{"--backend", "invalid", "--check"}, nil, &bytes.Buffer{}); err == nil {
		t.Fatal("accepted unknown backend")
	}
	if err := run([]string{"--backend", "core", "--check", "--project", project}, []string{"HERDR_CORE_BIN_PATH=/must-not-run"}, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
}
func TestCoreJSONAndIdentity(t *testing.T) {
	for _, body := range []string{
		`{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"needs input","data":{"kind":"blocked","hint":"read"}}}`,
		`{"jsonrpc":"2.0","id":2,"result":{"terminals":[]}}`,
		`{"jsonrpc":"1.0","id":1,"result":{"terminals":[]}}`,
		`{"jsonrpc":"2.0","id":1,"result":null}`,
		`{"jsonrpc":"2.0","id":1,"result":{}}`,
		`{"jsonrpc":"2.0","id":1,"result":{"terminals":null}}`,
		`{"jsonrpc":"2.0","id":1,"result":{"terminals":[{"status":"done"}]}}`,
		`invalid json`,
	} {
		h := testExecutable(t, "read request\nprintf '%s\\n' "+shellQuote(body))
		if _, err := (&Core{*h}).terminals(); err == nil {
			t.Fatalf("accepted invalid response: %s", body)
		}
	}
	h := testExecutable(t, "read request\nprintf '%s\\n' "+shellQuote(`{"jsonrpc":"2.0","method":"event","params":{}}`)+" "+shellQuote(`{"jsonrpc":"2.0","id":1,"result":{"terminals":[]}}`))
	if _, err := (&Core{*h}).terminals(); err != nil {
		t.Fatal(err)
	}
	m := StartedMember{Name: "member", TerminalID: "t1"}
	terminal := coreTerminal{Address: "t1", Name: "member", Cwd: "/project", Labels: map[string]string{"herdr-team": "leader"}}
	if !coreMatches(terminal, m, "/project", "leader") || coreMatches(terminal, m, "/other", "leader") {
		t.Fatal("incorrect identity match")
	}
}

func TestCoreRPCErrorAndCancellation(t *testing.T) {
	h := testExecutable(t, "read request\nprintf '%s\\n' "+shellQuote(`{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"needs input","data":{"kind":"blocked","hint":"read screen"}}}`))
	c := &Core{*h}
	var result any
	err := c.call(context.Background(), &result, "terminal.send", map[string]any{"text": "private role prompt"})
	if err == nil || !strings.Contains(err.Error(), "blocked") || strings.Contains(err.Error(), "context canceled") || strings.Contains(err.Error(), "private role prompt") {
		t.Fatalf("incorrect RPC diagnostic: %v", err)
	}
	h = testExecutable(t, "read request\nexec sleep 10\n")
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	err = (&Core{*h}).call(ctx, &result, "terminal.list", map[string]any{})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("transport ignored deadline: %v", err)
	}
}
