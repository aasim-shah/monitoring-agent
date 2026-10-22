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
