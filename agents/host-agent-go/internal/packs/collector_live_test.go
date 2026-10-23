package packs

import (
	"os"
	"strings"
	"testing"

	"pcp.local/hostagent/internal/control"
	"pcp.local/hostagent/internal/logs"
)

// TestRealCollectorAcceptsEveryPack validates each pack's receiver configuration with the
// built collector. Set PCP_OTELCOL to the pcp-otelcol binary (agents/release dist target).
func TestRealCollectorAcceptsEveryPack(t *testing.T) {
	bin := os.Getenv("PCP_OTELCOL")
	if bin == "" {
		t.Skip("PCP_OTELCOL not set")
	}
	f := newFixture(t, nil)
	f.a.Validate = Validator(bin)
	// With log files: filelog receivers, the count connector, and the logs pipeline (M11.2).
	f.a.Base.LogFiles = logs.FilePaths
	creds := "x"
	ack := f.a.Apply(control.AgentConfig{PolicyVersion: 2, Packs: []control.PackAssignment{
		{PackId: "redis", Settings: map[string]any{"endpoint": "127.0.0.1:6379"}},
		{PackId: "postgresql", Settings: map[string]any{"endpoint": "127.0.0.1:5432"}, SealedCredentials: creds},
		{PackId: "mysql", Settings: map[string]any{"endpoint": "127.0.0.1:3306"}, SealedCredentials: creds},
		{PackId: "mongodb", Settings: map[string]any{"endpoint": "127.0.0.1:27017"}},
		{PackId: "kafka", Settings: map[string]any{"endpoint": "127.0.0.1:9092"}},
		{PackId: "nginx", Settings: map[string]any{"endpoint": "http://127.0.0.1/nginx_status"}},
		{PackId: "nodejs", Settings: map[string]any{}},
	}})
	for _, r := range ack.Results {
		if r.Status != "applied" {
			t.Errorf("%s: %s", r.PackId, r.Message)
		}
	}
	// A receiver the collector rejects fails with the collector's message; the others still apply.
	ack = f.a.Apply(control.AgentConfig{PolicyVersion: 3, Packs: []control.PackAssignment{
		{PackId: "redis", Settings: map[string]any{"endpoint": "127.0.0.1"}},
		{PackId: "nodejs", Settings: map[string]any{}},
	}})
	r := results(ack)
	if r["redis"].Status != "failed" || !strings.Contains(r["redis"].Message, "missing port") || r["nodejs"].Status != "applied" {
		t.Errorf("ack = %+v", ack.Results)
	}
}
