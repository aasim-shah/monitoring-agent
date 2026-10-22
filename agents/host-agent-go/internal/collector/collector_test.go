package collector

import (
	"context"
	"encoding/json"
	"os/exec"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestConfigSendsHostMetricsOverMTLS(t *testing.T) {
	raw, err := Config(Input{
		IngestURL:  "https://ingest.example.com",
		CertFile:   "/var/lib/pcp-agent/agent.crt",
		KeyFile:    "/var/lib/pcp-agent/agent.key",
		CAFile:     "/var/lib/pcp-agent/ca.pem",
		ServerName: "ingest.localhost",
		StorageDir: "/var/lib/pcp-agent",
	})
	if err != nil {
		t.Fatal(err)
	}
	var cfg map[string]any
	if err := json.Unmarshal(raw, &cfg); err != nil {
		t.Fatalf("config is not JSON (and so not valid YAML): %v", err)
	}
	exp := cfg["exporters"].(map[string]any)["prometheus_remote_write"].(map[string]any)
	if exp["endpoint"] != "https://ingest.example.com/prometheus/api/v1/write" {
		t.Errorf("endpoint = %v", exp["endpoint"])
	}
	tls := exp["tls"].(map[string]any)
	for k, want := range map[string]string{"cert_file": "/var/lib/pcp-agent/agent.crt", "key_file": "/var/lib/pcp-agent/agent.key", "ca_file": "/var/lib/pcp-agent/ca.pem", "server_name_override": "ingest.localhost"} {
		if tls[k] != want {
			t.Errorf("tls.%s = %v, want %s", k, tls[k], want)
		}
	}
	pipeline := cfg["service"].(map[string]any)["pipelines"].(map[string]any)["metrics"].(map[string]any)
	if procs := pipeline["processors"].([]any); procs[0] != "memory_limiter" {
		t.Errorf("memory_limiter must run first (BR-04-09), got %v", procs)
	}
	scrapers := cfg["receivers"].(map[string]any)["host_metrics"].(map[string]any)["scrapers"].(map[string]any)
	for _, s := range []string{"cpu", "memory", "filesystem", "network", "load", "disk"} {
		if _, ok := scrapers[s]; !ok {
			t.Errorf("scraper %s missing", s)
		}
	}
	if strings.Contains(string(raw), "0.0.0.0") {
		t.Error("config opens a non-loopback listener")
	}
	telemetry := cfg["service"].(map[string]any)["telemetry"].(map[string]any)["metrics"].(map[string]any)
	if telemetry["level"] != "none" {
		t.Error("collector self-metrics must be off (no listener on :8888)")
	}
}

func TestConfigOmitsOptionalTLSFields(t *testing.T) {
	raw, _ := Config(Input{IngestURL: "https://ingest.example.com/", CertFile: "c", KeyFile: "k", StorageDir: "/s"})
	if strings.Contains(string(raw), "server_name_override") || strings.Contains(string(raw), "ca_file") {
		t.Errorf("production config should use system roots: %s", raw)
	}
	if !strings.Contains(string(raw), `"https://ingest.example.com/prometheus/api/v1/write"`) {
		t.Errorf("trailing slash not normalized: %s", raw)
	}
}

func TestSuperviseRestartsWithBackoffAndStops(t *testing.T) {
	var starts atomic.Int32
	var waits []time.Duration
	ctx, cancel := context.WithCancel(context.Background())
	s := Supervisor{
		Command: func() *exec.Cmd { starts.Add(1); return exec.Command("sh", "-c", "exit 1") },
		Sleep: func(_ context.Context, d time.Duration) {
			waits = append(waits, d)
			if len(waits) == 5 {
				cancel()
			}
		},
		Logf: t.Logf,
	}
	done := make(chan struct{})
	go func() { s.Run(ctx); close(done) }()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("supervisor did not stop after cancel")
	}
	want := []time.Duration{time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second, 16 * time.Second}
	for i, w := range want {
		if waits[i] != w {
			t.Fatalf("backoff %d = %v, want %v (all: %v)", i, waits[i], w, waits)
		}
	}
	if starts.Load() < 5 {
		t.Errorf("starts = %d", starts.Load())
	}
}

func TestSuperviseCapsBackoffAt60s(t *testing.T) {
	if got := backoff(20); got != 60*time.Second {
		t.Fatalf("backoff(20) = %v", got)
	}
}

func TestSuperviseStopsTheProcessOnCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	started := make(chan struct{}, 1)
	s := Supervisor{
		Command: func() *exec.Cmd { started <- struct{}{}; return exec.Command("sleep", "30") },
		Sleep:   func(context.Context, time.Duration) {},
		Logf:    t.Logf,
	}
	done := make(chan struct{})
	go func() { s.Run(ctx); close(done) }()
	<-started
	time.Sleep(100 * time.Millisecond)
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("running collector was not stopped")
	}
}
