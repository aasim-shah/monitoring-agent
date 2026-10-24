package packs

import (
	"strings"
	"testing"
	"time"

	"pcp.local/hostagent/internal/control"
)

func interval(t *testing.T, cfg, receiver string) string {
	t.Helper()
	i := strings.Index(cfg, `"`+receiver+`": {`)
	if i < 0 {
		t.Fatalf("receiver %s not in config", receiver)
	}
	j := strings.Index(cfg[i:], `"collection_interval": "`)
	rest := cfg[i+j+len(`"collection_interval": "`):]
	return rest[:strings.Index(rest, `"`)]
}

// BR-11-08: live boost is 5 s for one pack, reverted by the agent itself at its TTL.
func TestLiveBoostSetsFiveSecondsForOnePackAndRevertsAtItsTTL(t *testing.T) {
	f := newFixture(t, func(string) error { return nil })
	now := time.Date(2026, 10, 25, 10, 0, 0, 0, time.UTC)
	f.a.Now = func() time.Time { return now }
	f.a.Apply(control.AgentConfig{PolicyVersion: 2, Packs: []control.PackAssignment{
		{PackId: "redis", Settings: map[string]any{"endpoint": "127.0.0.1:6379"}},
		{PackId: "nginx", Settings: map[string]any{"endpoint": "http://127.0.0.1/nginx_status"}},
	}})
	restarts := f.restarts
	if err := f.a.StartBoost("redis", now.Add(10*time.Minute)); err != nil {
		t.Fatal(err)
	}
	cfg := f.config(t)
	if interval(t, cfg, "redis") != "5s" || interval(t, cfg, "nginx") != "30s" {
		t.Errorf("redis %s nginx %s", interval(t, cfg, "redis"), interval(t, cfg, "nginx"))
	}
	if f.restarts != restarts+1 {
		t.Error("the collector restarts with the boosted configuration")
	}
	// A config change during the boost keeps it.
	f.a.Apply(control.AgentConfig{PolicyVersion: 3, Packs: []control.PackAssignment{
		{PackId: "redis", Settings: map[string]any{"endpoint": "127.0.0.1:6379"}},
	}})
	if interval(t, f.config(t), "redis") != "5s" {
		t.Error("a policy change must not end the boost")
	}
	if f.a.ExpireBoosts() {
		t.Error("nothing expires before the TTL")
	}
	now = now.Add(10*time.Minute + time.Second)
	if !f.a.ExpireBoosts() || interval(t, f.config(t), "redis") != "30s" {
		t.Errorf("after the TTL: %s", interval(t, f.config(t), "redis"))
	}
	if f.a.ExpireBoosts() {
		t.Error("an expired boost reverts once")
	}
}

func TestLiveBoostRefusesUnknownPacksAndBadDeadlines(t *testing.T) {
	f := newFixture(t, func(string) error { return nil })
	now := time.Date(2026, 10, 25, 10, 0, 0, 0, time.UTC)
	f.a.Now = func() time.Time { return now }
	f.a.Apply(control.AgentConfig{PolicyVersion: 2, Packs: []control.PackAssignment{
		{PackId: "redis", Settings: map[string]any{"endpoint": "127.0.0.1:6379"}},
	}})
	for name, err := range map[string]error{
		"not enabled":    f.a.StartBoost("kafka", now.Add(time.Minute)),
		"already over":   f.a.StartBoost("redis", now.Add(-time.Second)),
		"longer than 10": f.a.StartBoost("redis", now.Add(12*time.Minute)),
	} {
		if err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if interval(t, f.config(t), "redis") != "30s" {
		t.Error("a refused boost changes nothing")
	}
}
