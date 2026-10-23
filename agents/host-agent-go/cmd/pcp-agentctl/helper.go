package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"net"
	"syscall"
	"time"

	"pcp.local/hostagent/internal/control"
	proto "pcp.local/agentprotocol"
)

const helperSocket = "/run/pcp-helper/helper.sock"

// forwardAction hands a signed action task, unchanged, to pcp-helper (D20). The agent never
// executes actions itself: the root helper verifies the signature with its own key, the expiry,
// single use, and the local allowlist.
func forwardAction(ctx context.Context, socket string, t proto.AgentTask, timeout time.Duration) control.TaskResult {
	var d net.Dialer
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	conn, err := d.DialContext(ctx, "unix", socket)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) || errors.Is(err, syscall.ECONNREFUSED) {
			return control.TaskResult{Status: "failed", Error: "pcp-helper is not installed on this host (re-run the installer with --enable-helper)"}
		}
		return control.TaskResult{Status: "failed", Error: "cannot reach pcp-helper: " + err.Error()}
	}
	defer conn.Close()
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	raw, _ := json.Marshal(t)
	if _, err := conn.Write(append(raw, '\n')); err != nil {
		return control.TaskResult{Status: "failed", Error: "pcp-helper: " + err.Error()}
	}
	var res control.TaskResult
	line, err := bufio.NewReader(conn).ReadBytes('\n')
	if err != nil || json.Unmarshal(line, &res) != nil || (res.Status != "succeeded" && res.Status != "failed") {
		return control.TaskResult{Status: "failed", Error: "pcp-helper did not answer"}
	}
	return res
}
