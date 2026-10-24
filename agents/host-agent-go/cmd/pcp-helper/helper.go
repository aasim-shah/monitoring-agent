package main

import (
	"crypto/ed25519"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"slices"
	"time"

	proto "pcp.local/agentprotocol"
	"pcp.local/hostagent/internal/control"
)

// unitName matches a systemd service unit: no paths, spaces, or shell characters (BR-16-09).
var unitName = regexp.MustCompile(`^[A-Za-z0-9@._-]+\.service$`)

// Systemd is the only thing the helper can do to the host.
type Systemd interface {
	Restart(unit string) error
	ActiveState(unit string) (string, error)
}

// Response is one JSON line back to the agent.
type Response struct {
	Status string         `json:"status"`
	Result map[string]any `json:"result,omitempty"`
	Error  string         `json:"error,omitempty"`
}

// Helper executes signed, unexpired, single-use service restarts for units in the local
// allowlist (D20, WB-16 UC-16-08). The allowlist is read at execution time, so a unit removed
// after approval is refused.
type Helper struct {
	Key           ed25519.PublicKey
	AllowlistPath string
	Used          *UsedTasks
	Systemd       Systemd
	Now           func() time.Time
	// Wait bounds the wait for "active" after the restart; Settle re-checks after it, so a
	// unit that crashes right away fails verification.
	Wait   time.Duration
	Settle time.Duration
	Sleep  func(time.Duration)
	// Installer handles Level 1 exporters (M18.3), only on hosts that opted in in helper.yaml.
	Installer *Installer
}

func failed(format string, args ...any) Response {
	return Response{Status: "failed", Error: fmt.Sprintf(format, args...)}
}

func (h *Helper) Handle(raw []byte) Response {
	ok, err := control.VerifyTask(raw, h.Key)
	if err != nil || !ok {
		return failed("task signature is not valid")
	}
	var task proto.AgentTask
	if err := json.Unmarshal(raw, &task); err != nil {
		return failed("task is not valid JSON")
	}
	if task.Type != "action" {
		return failed("only action tasks are accepted")
	}
	capability, _ := task.Payload["capability"].(string)
	if capability != "service_restart" && capability != "pack_install" && capability != "pack_remove" {
		return failed("capability %s is not supported by this helper", capability)
	}
	expires, err := time.Parse(time.RFC3339Nano, task.ExpiresAt)
	if err != nil || !h.Now().Before(expires) {
		return failed("task expired")
	}
	if capability != "service_restart" {
		return h.exporter(task, capability)
	}
	unit, _ := task.Payload["unit"].(string)
	if !unitName.MatchString(unit) {
		return failed("not a systemd service unit name")
	}
	data, err := os.ReadFile(h.AllowlistPath)
	var allowed []string
	if err == nil {
		allowed, _ = parseAllowlist(data)
	}
	if !slices.Contains(allowed, unit) {
		return failed("%s is not in the helper allowlist (/etc/pcp-agent/helper.yaml)", unit)
	}
	// Claimed before running: a replay is refused even if this execution fails.
	fresh, err := h.Used.Claim(task.Id, h.Now())
	if err != nil {
		return failed("cannot record the task: %v", err)
	}
	if !fresh {
		return failed("task was already used")
	}
	if err := h.Systemd.Restart(unit); err != nil {
		return failed("systemctl restart failed: %v", err)
	}
	state := h.waitActive(unit)
	if state == "active" && h.Settle > 0 {
		h.Sleep(h.Settle)
		state, _ = h.Systemd.ActiveState(unit)
	}
	result := map[string]any{"unit": unit, "restarted": true, "activeState": state}
	if state != "active" {
		return Response{Status: "failed", Result: result, Error: fmt.Sprintf("%s is %s after restart", unit, state)}
	}
	return Response{Status: "succeeded", Result: result}
}

func (h *Helper) waitActive(unit string) string {
	const step = 500 * time.Millisecond
	state := "unknown"
	for waited := time.Duration(0); waited <= h.Wait; waited += step {
		s, err := h.Systemd.ActiveState(unit)
		if err == nil {
			state = s
		}
		if state == "active" || state == "failed" {
			return state
		}
		h.Sleep(step)
	}
	return state
}

// exporter installs or removes a Level 1 exporter (M18.3) on a host whose owner set
// capabilities.pack_install.enabled: true in helper.yaml (install.sh --enable-pack-installer).
func (h *Helper) exporter(task proto.AgentTask, capability string) Response {
	data, _ := os.ReadFile(h.AllowlistPath)
	if !packInstallEnabled(data) || h.Installer == nil {
		return failed("pack installation is not enabled on this host (capabilities.pack_install.enabled in %s, or reinstall with --enable-pack-installer)", h.AllowlistPath)
	}
	fresh, err := h.Used.Claim(task.Id, h.Now())
	if err != nil {
		return failed("cannot record the task: %v", err)
	}
	if !fresh {
		return failed("task was already used")
	}
	name, _ := task.Payload["exporter"].(string)
	var result map[string]any
	if capability == "pack_install" {
		url, _ := task.Payload["downloadUrl"].(string)
		target, _ := task.Payload["target"].(string)
		result, err = h.Installer.Install(name, url, target)
	} else {
		result, err = h.Installer.Remove(name)
	}
	if err != nil {
		return failed("%v", err)
	}
	return Response{Status: "succeeded", Result: result}
}
