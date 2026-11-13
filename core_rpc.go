package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"
)

// Preserve the server's error fields so retry decisions never depend on a
// transport error string or an arbitrary occurrence of "unavailable".
type coreRPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    struct {
		Kind string `json:"kind"`
		Hint string `json:"hint"`
	} `json:"data"`
}

func (e *coreRPCError) Error() string {
	return fmt.Sprintf("RPC %d %s: %s; %s", e.Code, e.Data.Kind, e.Message, e.Data.Hint)
}

func startupSendWasNotTyped(err error, terminal string) bool {
	var rpc *coreRPCError
	return !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) &&
		errors.As(err, &rpc) && rpc.Code == -32000 && rpc.Data.Kind == "unavailable" &&
		rpc.Message == terminal+" is still starting: its output has not settled" &&
		rpc.Data.Hint == "nothing was typed; check hc read "+terminal+", then retry"
}

// Plain-mode JSON-RPC over the officially supported stdio transport. Keep
// stdin open until the response arrives: closing it early closes the connection.
// CLI run/ls output is deliberately abbreviated and is not the OpenRPC result.
func (c *Core) call(ctx context.Context, result any, method string, params any) (err error) {
	ctx, cancel := context.WithTimeout(ctx, 200*time.Second)
	defer cancel()
	request, err := json.Marshal(struct {
		JSONRPC string `json:"jsonrpc"`
		ID      int    `json:"id"`
		Method  string `json:"method"`
		Params  any    `json:"params"`
	}{"2.0", 1, method, params})
	if err != nil {
		return err
	}
	cmd := exec.CommandContext(ctx, c.Bin, "connect")
	cmd.Env = c.Env
	cmd.WaitDelay = time.Second
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return err
	}
	if err = cmd.Start(); err != nil {
		_ = stdin.Close()
		return fmt.Errorf("herdr-core %s: %w", method, err)
	}
	defer func() {
		_ = stdin.Close()
		contextErr := ctx.Err()
		hadError := err != nil
		// A malformed response must not leave a child or pipe behind.
		if err != nil {
			cancel()
		}
		waitErr := cmd.Wait()
		if !hadError {
			contextErr = ctx.Err()
		}
		if err == nil {
			err = waitErr
		}
		if err != nil {
			if detail := strings.TrimSpace(stderr.String()); detail != "" {
				err = fmt.Errorf("%w; stderr: %s", err, detail)
			}
			if contextErr != nil {
				err = errors.Join(err, contextErr)
			}
			err = fmt.Errorf("herdr-core %s: %w", method, err)
		}
	}()
	if _, err = stdin.Write(append(request, '\n')); err != nil {
		return err
	}
	decoder := json.NewDecoder(stdout)
	for {
		var response struct {
			JSONRPC string          `json:"jsonrpc"`
			ID      json.RawMessage `json:"id"`
			Method  string          `json:"method"`
			Result  json.RawMessage `json:"result"`
			Error   *coreRPCError   `json:"error"`
		}
		if err = decoder.Decode(&response); err != nil {
			if errors.Is(err, io.EOF) {
				return errors.New("connect closed before its JSON-RPC response")
			}
			return fmt.Errorf("invalid JSON-RPC response: %w", err)
		}
		if response.JSONRPC != "2.0" {
			return errors.New("invalid JSON-RPC version")
		}
		if len(response.ID) == 0 && response.Method != "" {
			continue
		} // notification
		if string(response.ID) != "1" {
			return errors.New("unexpected JSON-RPC response ID")
		}
		if response.Error != nil {
			return response.Error
		}
		if len(response.Result) == 0 || bytes.Equal(bytes.TrimSpace(response.Result), []byte("null")) {
			return errors.New("JSON-RPC response is missing result")
		}
		if err = json.Unmarshal(response.Result, result); err != nil {
			return fmt.Errorf("invalid API result: %w", err)
		}
		return nil
	}
}

func (c *Core) caller() string {
	if terminal := envMap(c.Env)["HC_TERMINAL_ID"]; terminal != "" {
		return terminal
	}
	// Match hc's caller convention. All send/wait calls share this identity,
	// including across connect subprocesses and interrupted waits.
	return fmt.Sprintf("ppid:%d", os.Getpid())
}

type coreWait struct {
	Terminal string `json:"terminal"`
	Ended    bool   `json:"ended"`
	Reason   string `json:"reason"`
	Status   string `json:"status"`
	Turn     uint64 `json:"turn"`
}

func (c *Core) waitSettled(ctx context.Context, terminal string, out io.Writer) error {
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		seconds := 30.0
		if deadline, ok := ctx.Deadline(); ok {
			seconds = min(seconds, max(0, time.Until(deadline).Seconds()))
		}
		var result coreWait
		if err := c.call(ctx, &result, "terminal.wait", map[string]any{"terminal": terminal, "caller": c.caller(), "timeout": seconds}); err != nil {
			return err
		}
		if result.Terminal != terminal {
			return errors.New("terminal.wait returned a different terminal identity")
		}
		switch result.Reason {
		case "message":
			// Core has delivered the message to the caller's input. Continue waiting
			// for this same send; its caller/terminal turn association is preserved.
			fmt.Fprintf(out, "%s: core message interrupted waiting; continuing the same turn…\n", terminal)
		case "timeout":
			// A check-in, not a new send. The outer context bounds the total wait.
			continue
		case "status":
			if result.Ended && (result.Status == "idle" || result.Status == "done") {
				return nil
			}
			if result.Status == "blocked" {
				return c.blockedError(ctx, terminal)
			}
			return fmt.Errorf("%s did not settle (status %s); inspect get/read for login, permission or agent errors", terminal, result.Status)
		default:
			return fmt.Errorf("%s wait ended with %s (status %s); inspect get/read before retrying", terminal, result.Reason, result.Status)
		}
	}
}

func (c *Core) blockedError(ctx context.Context, terminal string) error {
	var current coreTerminal
	err := c.call(ctx, &current, "terminal.get", map[string]any{"terminal": terminal})
	reason := "blocked"
	if current.Address == terminal && current.Status != nil && current.Status.Kind != "" {
		reason += ": " + current.Status.Kind
	}
	diagnostic := fmt.Errorf("%s needs user input (%s); open %s attach %s and handle the prompt manually; no automatic approval or role resend was attempted", terminal, reason, shellQuote(c.Bin), shellQuote(terminal))
	return errors.Join(diagnostic, err)
}

func (c *Core) initializeRole(entry StartedMember, project, token, prompt string, out io.Writer) error {
	return c.initializeRoleWithBudget(entry, project, token, prompt, out, 60*time.Second)
}

func (c *Core) initializeRoleWithBudget(entry StartedMember, project, token, prompt string, out io.Writer, startupBudget time.Duration) error {
	readyCtx, cancel := context.WithTimeout(context.Background(), startupBudget)
	defer cancel()
	var sent struct {
		Turn *uint64 `json:"turn"`
	}
	for {
		if err := c.waitSettled(readyCtx, entry.TerminalID, out); err != nil {
			return err
		}
		var current coreTerminal
		if err := c.call(readyCtx, &current, "terminal.get", map[string]any{"terminal": entry.TerminalID}); err != nil {
			return err
		}
		if !coreMatches(current, entry, project, token) || current.State != "live" || (current.status() != "idle" && current.status() != "done") {
			return fmt.Errorf("%s is not settled or its identity changed (status %s); inspect get/read before retrying", entry.Name, current.status())
		}
		params := map[string]any{"terminal": entry.TerminalID, "caller": c.caller(), "text": prompt, "force": false, "wait": false}
		// The published schema only accepts idle/working for `if`; done is a
		// settled status but is not a legal value for this optional condition.
		if current.status() == "idle" {
			params["if"] = "idle"
		}
		err := c.call(readyCtx, &sent, "terminal.send", params)
		if err == nil {
			break
		}
		if !startupSendWasNotTyped(err, entry.TerminalID) {
			return err
		}
		fmt.Fprintf(out, "%s: startup output is still settling; nothing was typed, retrying…\n", entry.Name)
		// Match core's own first_message retry: this specific settle rejection
		// occurs before any paste. This is RPC retry backoff, not status polling.
		timer := time.NewTimer(100 * time.Millisecond)
		select {
		case <-readyCtx.Done():
			timer.Stop()
			return errors.Join(err, readyCtx.Err())
		case <-timer.C:
		}
	}
	cancel()
	if sent.Turn == nil {
		return errors.New("terminal.send response is missing turn; delivery may have occurred")
	}
	turnCtx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	// Plain terminal.wait with the same caller follows exactly this send even
	// when send reports started:false. Never send again to recover a wait.
	if err := c.waitSettled(turnCtx, entry.TerminalID, out); err != nil {
		return fmt.Errorf("role initialization: %w; delivery may have occurred", err)
	}
	return nil
}
