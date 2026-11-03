package main

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func readinessFixture() (*fakeHerdr, StartedMember) {
	entry := StartedMember{ID: "dev", Name: "team-dev", PaneID: "pane", TerminalID: "terminal", Kind: "codex"}
	return &fakeHerdr{Agents: []Agent{{Name: entry.Name, PaneID: entry.PaneID, TerminalID: entry.TerminalID, WorkspaceID: "workspace", Kind: entry.Kind, Status: "idle", InteractiveReady: true}}}, entry
}

func promptCount(client *fakeHerdr) int {
	count := 0
	for _, call := range client.Calls {
		if len(call) > 1 && call[0] == "agent" && call[1] == "prompt" {
			count++
		}
	}
	return count
}

func TestReadinessWaitsForStartupAndSendsOnce(t *testing.T) {
	for _, status := range []string{"starting", "initializing", "idle"} {
		t.Run(status, func(t *testing.T) {
			client, entry := readinessFixture()
			reads := 0
			client.GetAgent = func(a Agent) Agent {
				reads++
				if reads < 3 {
					a.Status = status
					a.InteractiveReady = false
				}
				return a
			}
			var stages []string
			err := initializePromptWithReadiness(client, entry, "workspace", "role", time.Second, time.Millisecond, func(stage string) { stages = append(stages, stage) })
			if err != nil {
				t.Fatal(err)
			}
			if reads != 3 || promptCount(client) != 1 {
				t.Fatalf("reads=%d prompts=%d", reads, promptCount(client))
			}
			if strings.Join(stages, ",") != "waiting for readiness,initializing role" {
				t.Fatal(stages)
			}
		})
	}
}

func TestReadinessTimeoutNeverPrompts(t *testing.T) {
	client, entry := readinessFixture()
	client.GetAgent = func(a Agent) Agent { a.InteractiveReady = false; return a }
	err := initializePromptWithReadiness(client, entry, "workspace", "role", 5*time.Millisecond, time.Millisecond, nil)
	if err == nil || !strings.Contains(err.Error(), "readiness timed out") || !strings.Contains(err.Error(), "login or permission") {
		t.Fatal(err)
	}
	if promptCount(client) != 0 {
		t.Fatal("prompt delivered before readiness")
	}
}

func TestReadinessRejectsIdentityChangeAfterWaiting(t *testing.T) {
	client, entry := readinessFixture()
	reads := 0
	client.GetAgent = func(a Agent) Agent {
		reads++
		if reads == 1 {
			a.Status = "starting"
			a.InteractiveReady = false
		} else {
			a.TerminalID = "replacement"
		}
		return a
	}
	err := initializePromptWithReadiness(client, entry, "workspace", "role", time.Second, time.Millisecond, nil)
	if err == nil || !strings.Contains(err.Error(), "identity changed") || promptCount(client) != 0 {
		t.Fatal(err)
	}
}

func TestReadinessDoesNotRetryUncertainPrompt(t *testing.T) {
	client, entry := readinessFixture()
	client.Prompt = func(string) (Result, error) { return Result{}, errors.New("delivery uncertain") }
	err := initializePromptWithReadiness(client, entry, "workspace", "role", time.Second, time.Millisecond, nil)
	if err == nil || !strings.Contains(err.Error(), "delivery uncertain") || promptCount(client) != 1 {
		t.Fatal(err)
	}
}

func TestInitializationReportsMemberProgress(t *testing.T) {
	project, directory, team := fixture(t)
	var out bytes.Buffer
	if err := initialize(team, project, "w1", directory, nil, &fakeHerdr{}, &out); err != nil {
		t.Fatal(err)
	}
	for _, stage := range []string{"checking readiness", "initializing role", ": initialized"} {
		if !strings.Contains(out.String(), stage) {
			t.Fatalf("missing %s in %s", stage, out.String())
		}
	}
}

func TestStartFailureIncludesActionablePaneDiagnostic(t *testing.T) {
	project, directory, team := fixture(t)
	err := start(t, team, project, directory, &fakeHerdr{FailStart: "dev"})
	if err == nil {
		t.Fatal("expected start failure")
	}
	for _, detail := range []string{"starting ", "in pane w1:p2", "login, permissions", "no automatic restart"} {
		if !strings.Contains(err.Error(), detail) {
			t.Fatalf("missing %q: %v", detail, err)
		}
	}
}

func TestReadinessRejectsReadyResponseAfterBudget(t *testing.T) {
	client, entry := readinessFixture()
	client.GetAgent = func(a Agent) Agent { time.Sleep(20 * time.Millisecond); return a }
	err := initializePromptWithReadiness(client, entry, "workspace", "role", 5*time.Millisecond, time.Millisecond, nil)
	if !errors.Is(err, context.DeadlineExceeded) || promptCount(client) != 0 {
		t.Fatalf("late ready authorized prompt: err=%v prompts=%d", err, promptCount(client))
	}
}

type contextualReadinessClient struct {
	*fakeHerdr
	sawDeadline bool
	cancelled   bool
}

func (c *contextualReadinessClient) CallContext(ctx context.Context, args ...string) (Result, error) {
	_, c.sawDeadline = ctx.Deadline()
	<-ctx.Done()
	c.cancelled = true
	return Result{}, ctx.Err()
}
func TestReadinessPassesRemainingBudgetToClient(t *testing.T) {
	fake, entry := readinessFixture()
	client := &contextualReadinessClient{fakeHerdr: fake}
	err := initializePromptWithReadiness(client, entry, "workspace", "role", 5*time.Millisecond, time.Millisecond, nil)
	if !errors.Is(err, context.DeadlineExceeded) || !client.sawDeadline || !client.cancelled || promptCount(fake) != 0 {
		t.Fatalf("context not enforced: err=%v client=%+v", err, client)
	}
}

func TestHerdrCallContextCancelsSubprocess(t *testing.T) {
	client := testExecutable(t, "exec sleep 10\n")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	started := time.Now()
	_, err := client.CallContext(ctx, "agent", "get", "member")
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
	if time.Since(started) > time.Second {
		t.Fatal("CLI exceeded context budget")
	}
}
