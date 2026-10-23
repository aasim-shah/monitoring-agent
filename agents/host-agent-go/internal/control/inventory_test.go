package control

import (
	"context"
	"encoding/json"
	"errors"
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

func TestPostChunkReportsAClosedSession(t *testing.T) {
	var got proto.StreamChunk
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/agent/v1/streams/11111111-1111-4111-8111-111111111111/chunks" {
			_ = json.NewDecoder(r.Body).Decode(&got)
			w.WriteHeader(http.StatusAccepted)
			_, _ = w.Write([]byte(`{"accepted":true}`))
			return
		}
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"code":"not_found","message":"Not found"}`))
	}))
	defer srv.Close()
	c := New(srv.URL, srv.Client())
	ctx := context.Background()
	if err := c.PostChunk(ctx, "11111111-1111-4111-8111-111111111111", 3, []string{"a"}, false); err != nil {
		t.Fatal(err)
	}
	if got.Sequence != 3 || got.Lines[0] != "a" || got.Final || got.SentAt == "" {
		t.Errorf("chunk = %+v", got)
	}
	err := c.PostChunk(ctx, "22222222-2222-4222-8222-222222222222", 0, []string{}, true)
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Status != http.StatusNotFound {
		t.Errorf("closed session err = %v", err)
	}
}
