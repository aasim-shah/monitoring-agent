package control

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	proto "pcp.local/agentprotocol"
)

func TestPostInventory(t *testing.T) {
	var got proto.Inventory
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/agent/v1/inventory" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_ = json.NewDecoder(r.Body).Decode(&got)
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()
	c := New(srv.URL, srv.Client())
	inv := proto.Inventory{CollectedAt: "2026-10-22T12:00:00Z", Services: []proto.InventoryServices{{Pack: "redis", Name: "Redis", ProcessCount: 1}}}
	if err := c.PostInventory(context.Background(), inv); err != nil {
		t.Fatal(err)
	}
	if got.CollectedAt != inv.CollectedAt || len(got.Services) != 1 || got.Services[0].Pack != "redis" {
		t.Errorf("server received %+v", got)
	}
}

func TestConfigFetchAndAck(t *testing.T) {
	var ack ConfigAck
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method + " " + r.URL.Path {
		case "GET /agent/v1/config":
			_, _ = w.Write([]byte(`{"policyVersion":4,"packs":[{"packId":"redis","settings":{"endpoint":"127.0.0.1:6379"},"sealedCredentials":"abc"}]}`))
		case "POST /agent/v1/config/ack":
			_ = json.NewDecoder(r.Body).Decode(&ack)
			w.WriteHeader(http.StatusNoContent)
		case "POST /agent/v1/heartbeat":
			w.WriteHeader(http.StatusAccepted)
			_, _ = w.Write([]byte(`{"accepted":true,"policyVersion":4}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()
	c := New(srv.URL, srv.Client())
	ctx := context.Background()
	hb, err := c.Heartbeat(ctx, proto.Heartbeat{Sequence: 1, AgentVersion: "1", PolicyVersion: 1, Health: "ok"})
	if err != nil || !hb.Accepted || hb.PolicyVersion != 4 {
		t.Fatalf("heartbeat = %+v, %v", hb, err)
	}
	cfg, err := c.Config(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.PolicyVersion != 4 || len(cfg.Packs) != 1 || cfg.Packs[0].PackId != "redis" || cfg.Packs[0].SealedCredentials != "abc" || cfg.Packs[0].Settings["endpoint"] != "127.0.0.1:6379" {
		t.Errorf("config = %+v", cfg)
	}
	if err := c.AckConfig(ctx, ConfigAck{PolicyVersion: 4, Results: []PackResult{{PackId: "redis", Status: "failed", Message: "bad"}}}); err != nil {
		t.Fatal(err)
	}
	if ack.PolicyVersion != 4 || len(ack.Results) != 1 || ack.Results[0].Message != "bad" {
		t.Errorf("ack = %+v", ack)
	}
}
