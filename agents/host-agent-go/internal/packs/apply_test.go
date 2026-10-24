package packs

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"pcp.local/hostagent/internal/collector"
	"pcp.local/hostagent/internal/control"
)

type fixture struct {
	a        *Applier
	restarts int
}

func newFixture(t *testing.T, validate func(cfg string) error) *fixture {
	t.Helper()
	f := &fixture{}
	dir := t.TempDir()
	f.a = &Applier{
		Dir:  dir,
		Base: collector.Input{IngestURL: "https://ingest.example.com", CertFile: "c", KeyFile: "k", StorageDir: dir},
		Open: func(sealed string) (map[string]string, error) {
			if sealed == "bad" {
				return nil, errors.New("sealed credentials cannot be opened with this agent's key")
			}
			return map[string]string{"username": "mon", "password": sealed}, nil
		},
		Validate: func(path string) error {
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			return validate(string(data))
		},
		Restart: func() { f.restarts++ },
	}
	return f
}

func (f *fixture) config(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(f.a.Dir, ConfigFile))
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func results(ack control.ConfigAck) map[string]control.PackResult {
	out := map[string]control.PackResult{}
	for _, r := range ack.Results {
		out[r.PackId] = r
	}
	return out
}

func ok(string) error { return nil }

func TestApplyOpensCredentialsAndKeepsThemForLaterVersions(t *testing.T) {
	f := newFixture(t, ok)
	pg := control.PackAssignment{PackId: "postgresql", Settings: map[string]any{"endpoint": "127.0.0.1:5432"}, SealedCredentials: "s3cret"}
	ack := f.a.Apply(control.AgentConfig{PolicyVersion: 2, Packs: []control.PackAssignment{pg}})
	if ack.PolicyVersion != 2 || results(ack)["postgresql"].Status != "applied" || f.restarts != 1 {
		t.Fatalf("ack = %+v, restarts = %d", ack, f.restarts)
	}
	if !strings.Contains(f.config(t), `"password": "s3cret"`) {
		t.Error("credentials missing from the collector configuration")
	}
	info, _ := os.Stat(filepath.Join(f.a.Dir, ConfigFile))
	if info.Mode().Perm() != 0o600 {
		t.Errorf("collector config mode = %v", info.Mode())
	}
	// Version 3 adds redis; the control plane no longer sends postgresql's ciphertext.
	pg.SealedCredentials = ""
	redis := control.PackAssignment{PackId: "redis", Settings: map[string]any{"endpoint": "127.0.0.1:6379"}}
	ack = f.a.Apply(control.AgentConfig{PolicyVersion: 3, Packs: []control.PackAssignment{pg, redis}})
	if r := results(ack); r["postgresql"].Status != "applied" || r["redis"].Status != "applied" {
		t.Fatalf("ack = %+v", ack)
	}
	if !strings.Contains(f.config(t), `"password": "s3cret"`) {
		t.Error("stored credentials were not reused")
	}
	st, err := LoadStore(f.a.Dir)
	if err != nil || st.PolicyVersion != 3 || len(st.Packs) != 2 {
		t.Errorf("store = %+v, %v", st, err)
	}
	// Version 4 removes postgresql: its credentials are forgotten.
	f.a.Apply(control.AgentConfig{PolicyVersion: 4, Packs: []control.PackAssignment{redis}})
	if strings.Contains(f.config(t), "s3cret") {
		t.Error("removed pack still configured")
	}
	raw, _ := os.ReadFile(filepath.Join(f.a.Dir, StoreFile))
	if strings.Contains(string(raw), "s3cret") {
		t.Error("removed pack's credentials still stored")
	}
}

// Review Focus #2: a configuration the collector rejects never replaces the running one.
func TestApplyKeepsPreviousConfigWhenValidationFails(t *testing.T) {
	f := newFixture(t, func(cfg string) error {
		if strings.Contains(cfg, `"mysql"`) {
			return errors.New("receivers::mysql: endpoint: invalid port")
		}
		return nil
	})
	redis := control.PackAssignment{PackId: "redis", Settings: map[string]any{"endpoint": "127.0.0.1:6379"}}
	f.a.Apply(control.AgentConfig{PolicyVersion: 2, Packs: []control.PackAssignment{redis}})
	mysql := control.PackAssignment{PackId: "mysql", Settings: map[string]any{"endpoint": "127.0.0.1:3306"}, SealedCredentials: "p"}
	ack := f.a.Apply(control.AgentConfig{PolicyVersion: 3, Packs: []control.PackAssignment{redis, mysql}})
	r := results(ack)
	if r["redis"].Status != "applied" || r["mysql"].Status != "failed" || !strings.Contains(r["mysql"].Message, "invalid port") {
		t.Errorf("ack = %+v", ack)
	}
	if cfg := f.config(t); strings.Contains(cfg, `"mysql"`) || !strings.Contains(cfg, `"redis"`) {
		t.Errorf("collector config = %s", cfg)
	}

	allBad := newFixture(t, func(string) error { return errors.New("collector rejected everything") })
	before := []byte(`{"previous": true}`)
	_ = os.WriteFile(filepath.Join(allBad.a.Dir, ConfigFile), before, 0o600)
	ack = allBad.a.Apply(control.AgentConfig{PolicyVersion: 2, Packs: []control.PackAssignment{redis}})
	if results(ack)["redis"].Status != "failed" || allBad.restarts != 0 {
		t.Errorf("ack = %+v, restarts = %d", ack, allBad.restarts)
	}
	if got := allBad.config(t); got != string(before) {
		t.Errorf("previous config replaced: %s", got)
	}
}

func TestApplyReportsCredentialsItCannotOpen(t *testing.T) {
	f := newFixture(t, ok)
	ack := f.a.Apply(control.AgentConfig{PolicyVersion: 2, Packs: []control.PackAssignment{
		{PackId: "postgresql", Settings: map[string]any{"endpoint": "127.0.0.1:5432"}, SealedCredentials: "bad"},
		{PackId: "docker", Settings: map[string]any{}},
		{PackId: "nodejs", Settings: map[string]any{}},
	}})
	r := results(ack)
	if r["postgresql"].Status != "failed" || !strings.Contains(r["postgresql"].Message, "cannot be opened") {
		t.Errorf("postgresql = %+v", r["postgresql"])
	}
	if r["docker"].Status != "failed" || r["nodejs"].Status != "applied" {
		t.Errorf("ack = %+v", ack)
	}
}

func TestApplyCarriesTheRetainedLogsOptIn(t *testing.T) {
	f := newFixture(t, ok)
	cfg := control.AgentConfig{PolicyVersion: 3, Packs: []control.PackAssignment{{PackId: "redis", Settings: map[string]any{"endpoint": "127.0.0.1:6379"}, RetainLogs: true}}}
	if ack := f.a.Apply(cfg); results(ack)["redis"].Status != "applied" {
		t.Fatalf("ack = %+v", ack)
	}
	st, err := LoadStore(f.a.Dir)
	if err != nil || len(st.Packs) != 1 || !st.Packs[0].RetainLogs {
		t.Fatalf("store = %+v %v", st, err)
	}
}
