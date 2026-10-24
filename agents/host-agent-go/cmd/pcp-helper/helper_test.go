package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"pcp.local/hostagent/internal/control"
)

var now = time.Date(2026, 10, 24, 10, 0, 0, 0, time.UTC)

type fakeSystemd struct {
	restarted []string
	states    []string // returned in order by ActiveState; the last one repeats
	failWith  error
}

func (f *fakeSystemd) Restart(unit string) error {
	f.restarted = append(f.restarted, unit)
	return f.failWith
}

func (f *fakeSystemd) ActiveState(unit string) (string, error) {
	if len(f.states) == 0 {
		return "active", nil
	}
	s := f.states[0]
	if len(f.states) > 1 {
		f.states = f.states[1:]
	}
	return s, nil
}

func signed(t *testing.T, priv ed25519.PrivateKey, task map[string]any) []byte {
	t.Helper()
	raw, _ := json.Marshal(task)
	canonical, err := control.CanonicalTask(raw)
	if err != nil {
		t.Fatal(err)
	}
	task["signature"] = base64.StdEncoding.EncodeToString(ed25519.Sign(priv, canonical))
	out, _ := json.Marshal(task)
	return out
}

func restartTask(id, unit string, expires time.Time) map[string]any {
	return map[string]any{
		"id":                id,
		"type":              "action",
		"expiresAt":         expires.Format(time.RFC3339Nano),
		"resourceScope":     map[string]any{"unit": unit},
		"maxRuntimeSeconds": 90,
		"maxResponseBytes":  4096,
		"approvalId":        "b6f5a7c2-1111-4c5b-9a6f-0e1d2c3b4a59",
		"payload":           map[string]any{"capability": "service_restart", "unit": unit},
	}
}

type setup struct {
	helper *Helper
	sd     *fakeSystemd
	priv   ed25519.PrivateKey
	dir    string
}

func newSetup(t *testing.T, allow string) setup {
	t.Helper()
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	dir := t.TempDir()
	allowPath := filepath.Join(dir, "helper.yaml")
	if err := os.WriteFile(allowPath, []byte(allow), 0o644); err != nil {
		t.Fatal(err)
	}
	sd := &fakeSystemd{}
	return setup{
		helper: &Helper{
			Key:           pub,
			AllowlistPath: allowPath,
			Used:          &UsedTasks{Path: filepath.Join(dir, "used-tasks")},
			Systemd:       sd,
			Now:           func() time.Time { return now },
			Wait:          time.Second,
			Settle:        0,
			Sleep:         func(time.Duration) {},
		},
		sd: sd, priv: priv, dir: dir,
	}
}

const allowAPI = `capabilities:
  service_restart:
    units: [firemaps-api.service, firemaps-worker.service]
  pack_install:
    enabled: false
`

func TestRestartsAnAllowlistedUnitAndVerifiesIt(t *testing.T) {
	s := newSetup(t, allowAPI)
	s.sd.states = []string{"activating", "active"}
	res := s.helper.Handle(signed(t, s.priv, restartTask("t1", "firemaps-api.service", now.Add(10*time.Minute))))
	if res.Status != "succeeded" {
		t.Fatalf("status %s: %s", res.Status, res.Error)
	}
	if res.Result["unit"] != "firemaps-api.service" || res.Result["activeState"] != "active" || res.Result["restarted"] != true {
		t.Fatalf("result %v", res.Result)
	}
	if strings.Join(s.sd.restarted, ",") != "firemaps-api.service" {
		t.Fatalf("restarted %v", s.sd.restarted)
	}
}

func TestRefusesUnsignedTamperedAndExpiredTasks(t *testing.T) {
	s := newSetup(t, allowAPI)
	unsigned, _ := json.Marshal(restartTask("t2", "firemaps-api.service", now.Add(time.Minute)))
	if r := s.helper.Handle(unsigned); r.Error != "task signature is not valid" {
		t.Fatalf("unsigned: %+v", r)
	}
	good := signed(t, s.priv, restartTask("t3", "firemaps-api.service", now.Add(time.Minute)))
	tampered := []byte(strings.Replace(string(good), "firemaps-api.service\"}", "firemaps-worker.service\"}", 1))
	if r := s.helper.Handle(tampered); r.Error != "task signature is not valid" {
		t.Fatalf("tampered: %+v", r)
	}
	expired := signed(t, s.priv, restartTask("t4", "firemaps-api.service", now.Add(-time.Second)))
	if r := s.helper.Handle(expired); r.Error != "task expired" {
		t.Fatalf("expired: %+v", r)
	}
	if len(s.sd.restarted) != 0 {
		t.Fatalf("restarted %v", s.sd.restarted)
	}
}

func TestRefusesAReplayedTask(t *testing.T) {
	s := newSetup(t, allowAPI)
	task := signed(t, s.priv, restartTask("t5", "firemaps-api.service", now.Add(time.Minute)))
	if r := s.helper.Handle(task); r.Status != "succeeded" {
		t.Fatalf("first: %+v", r)
	}
	// A new helper process (restart) still remembers the task ID.
	again := *s.helper
	again.Used = &UsedTasks{Path: filepath.Join(s.dir, "used-tasks")}
	if r := again.Handle(task); r.Error != "task was already used" {
		t.Fatalf("replay: %+v", r)
	}
	if len(s.sd.restarted) != 1 {
		t.Fatalf("restarted %v", s.sd.restarted)
	}
}

func TestRefusesUnitsOutsideTheLocalAllowlist(t *testing.T) {
	s := newSetup(t, allowAPI)
	r := s.helper.Handle(signed(t, s.priv, restartTask("t6", "sshd.service", now.Add(time.Minute))))
	if r.Error != "sshd.service is not in the helper allowlist (/etc/pcp-agent/helper.yaml)" {
		t.Fatalf("%+v", r)
	}
	for _, unit := range []string{"x.service; reboot", "../../etc/passwd", "a b.service"} {
		r := s.helper.Handle(signed(t, s.priv, restartTask("u-"+unit, unit, now.Add(time.Minute))))
		if r.Error != "not a systemd service unit name" {
			t.Fatalf("%q: %+v", unit, r)
		}
	}
	if len(s.sd.restarted) != 0 {
		t.Fatalf("restarted %v", s.sd.restarted)
	}
}

func TestRefusesOtherTaskTypesAndCapabilities(t *testing.T) {
	s := newSetup(t, allowAPI)
	task := restartTask("t7", "firemaps-api.service", now.Add(time.Minute))
	task["payload"] = map[string]any{"capability": "shell", "unit": "firemaps-api.service"}
	if r := s.helper.Handle(signed(t, s.priv, task)); r.Error != "capability shell is not supported by this helper" {
		t.Fatalf("%+v", r)
	}
	task = restartTask("t8", "firemaps-api.service", now.Add(time.Minute))
	task["type"] = "inspect"
	if r := s.helper.Handle(signed(t, s.priv, task)); r.Error != "only action tasks are accepted" {
		t.Fatalf("%+v", r)
	}
}

func TestSignatureFromAnotherKeyIsRefused(t *testing.T) {
	// Review Focus #1: a key swapped into the agent's state file signs nothing the helper trusts.
	s := newSetup(t, allowAPI)
	_, other, _ := ed25519.GenerateKey(rand.Reader)
	if r := s.helper.Handle(signed(t, other, restartTask("t9", "firemaps-api.service", now.Add(time.Minute)))); r.Error != "task signature is not valid" {
		t.Fatalf("%+v", r)
	}
}

func TestFailsWhenTheUnitIsNotActiveAfterRestart(t *testing.T) {
	s := newSetup(t, allowAPI)
	s.sd.states = []string{"activating", "failed"}
	r := s.helper.Handle(signed(t, s.priv, restartTask("t10", "firemaps-api.service", now.Add(time.Minute))))
	if r.Status != "failed" || r.Error != "firemaps-api.service is failed after restart" || r.Result["activeState"] != "failed" {
		t.Fatalf("%+v", r)
	}
	s.sd.failWith = errors.New("Job for firemaps-api.service failed")
	r = s.helper.Handle(signed(t, s.priv, restartTask("t11", "firemaps-api.service", now.Add(time.Minute))))
	if r.Status != "failed" || !strings.Contains(r.Error, "systemctl restart failed") {
		t.Fatalf("%+v", r)
	}
}

func TestBlockListAllowlistAndMissingFile(t *testing.T) {
	units, err := parseAllowlist([]byte("# local allowlist\ncapabilities:\n  service_restart:\n    units:\n      - a.service   # api\n      - b.service\n  pack_install:\n    enabled: false\n"))
	if err != nil || strings.Join(units, ",") != "a.service,b.service" {
		t.Fatalf("%v %v", units, err)
	}
	units, _ = parseAllowlist([]byte("capabilities:\n  service_restart:\n    units: []\n"))
	if len(units) != 0 {
		t.Fatalf("%v", units)
	}
	s := newSetup(t, allowAPI)
	s.helper.AllowlistPath = filepath.Join(s.dir, "missing.yaml")
	r := s.helper.Handle(signed(t, s.priv, restartTask("t12", "firemaps-api.service", now.Add(time.Minute))))
	if !strings.Contains(r.Error, "is not in the helper allowlist") {
		t.Fatalf("%+v", r)
	}
}

func TestSocketIsOnlyForTheAgentGroup(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "helper.sock")
	ln, err := listen(path, os.Getgid())
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o660 || info.Mode()&os.ModeSocket == 0 {
		t.Fatalf("mode %v", info.Mode())
	}
	s := newSetup(t, allowAPI)
	go serve(ln, s.helper)
	conn, err := net.Dial("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	task := signed(t, s.priv, restartTask("t13", "firemaps-api.service", now.Add(time.Minute)))
	if _, err := conn.Write(append(task, '\n')); err != nil {
		t.Fatal(err)
	}
	var res Response
	if err := json.NewDecoder(conn).Decode(&res); err != nil || res.Status != "succeeded" {
		t.Fatalf("%+v %v", res, err)
	}
}
