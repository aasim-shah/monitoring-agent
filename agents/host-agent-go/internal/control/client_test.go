package control

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	proto "pcp.local/agentprotocol"
)

func signedTask(t *testing.T, key ed25519.PrivateKey, id, target string, expires time.Time) map[string]any {
	t.Helper()
	task := map[string]any{
		"id":                id,
		"type":              "inspect",
		"expiresAt":         expires.UTC().Format("2006-01-02T15:04:05.000Z"),
		"resourceScope":     map[string]any{},
		"maxRuntimeSeconds": json.Number("60"),
		"maxResponseBytes":  json.Number("65536"),
		"payload":           map[string]any{"target": target},
	}
	canonical, err := canonicalJSON(task)
	if err != nil {
		t.Fatal(err)
	}
	task["signature"] = base64.StdEncoding.EncodeToString(ed25519.Sign(key, canonical))
	return task
}

func TestClientFlow(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(nil)
	var heartbeats, results atomic.Int32
	future := time.Now().Add(10 * time.Minute)
	mux := http.NewServeMux()
	mux.HandleFunc("POST /agent/v1/enroll", func(w http.ResponseWriter, r *http.Request) {
		var req proto.EnrollRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		if req.EnrollmentToken != "pcp_enr_test" || !strings.Contains(req.CsrPem, "CERTIFICATE REQUEST") || req.ProtocolVersion != "1.0" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(proto.EnrollResponse{AgentId: "a1", CertificatePem: "cert", ChainPem: "chain", NotAfter: future.Format(time.RFC3339), TaskSigningPublicKey: base64.StdEncoding.EncodeToString(pub)})
	})
	mux.HandleFunc("POST /agent/v1/heartbeat", func(w http.ResponseWriter, r *http.Request) {
		heartbeats.Add(1)
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"accepted":true,"policyVersion":1}`))
	})
	mux.HandleFunc("GET /agent/v1/tasks", func(w http.ResponseWriter, r *http.Request) {
		good := signedTask(t, priv, "11111111-1111-4111-8111-111111111111", "agent_info", future)
		bad := signedTask(t, priv, "22222222-2222-4222-8222-222222222222", "agent_info", future)
		bad["payload"] = map[string]any{"target": "agent_infp"}
		expired := signedTask(t, priv, "33333333-3333-4333-8333-333333333333", "agent_info", time.Now().Add(-time.Minute))
		_ = json.NewEncoder(w).Encode(map[string]any{"tasks": []any{good, bad, expired}})
	})
	mux.HandleFunc("POST /agent/v1/tasks/{id}/result", func(w http.ResponseWriter, r *http.Request) {
		results.Add(1)
		w.WriteHeader(http.StatusNoContent)
	})
	srv := httptest.NewTLSServer(mux)
	defer srv.Close()

	id, err := GenerateIdentity(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	c := New(srv.URL, srv.Client())
	ctx := context.Background()
	enrolled, err := c.Enroll(ctx, "pcp_enr_test", id, proto.EnrollRequestHost{Hostname: "h", MachineId: "m", Os: "linux", Arch: "amd64"}, "1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	accepted, err := c.Heartbeat(ctx, proto.Heartbeat{Sequence: 1, AgentVersion: "1.0.0", PolicyVersion: 1, Capabilities: []string{}, Health: "ok"})
	if err != nil || !accepted {
		t.Fatalf("heartbeat accepted=%v err=%v", accepted, err)
	}
	key, _ := base64.StdEncoding.DecodeString(enrolled.TaskSigningPublicKey)
	tasks, rejected, err := c.PollTasks(ctx, 0, ed25519.PublicKey(key))
	if err != nil {
		t.Fatal(err)
	}
	if len(tasks) != 1 || tasks[0].Id != "11111111-1111-4111-8111-111111111111" {
		t.Fatalf("tasks = %+v, want only the valid one", tasks)
	}
	if rejected != 2 {
		t.Errorf("rejected = %d, want 2 (tampered and expired)", rejected)
	}
	if err := c.PostResult(ctx, tasks[0].Id, TaskResult{Status: "succeeded", Result: map[string]any{"ok": true}}); err != nil {
		t.Fatal(err)
	}
	if heartbeats.Load() != 1 || results.Load() != 1 {
		t.Errorf("heartbeats=%d results=%d", heartbeats.Load(), results.Load())
	}
}

func TestClientReportsAPIErrors(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"code":"invalid_enrollment_token","message":"nope"}`))
	}))
	defer srv.Close()
	id, _ := GenerateIdentity(t.TempDir())
	_, err := New(srv.URL, srv.Client()).Enroll(context.Background(), "x", id, proto.EnrollRequestHost{}, "1.0.0")
	apiErr, ok := err.(*APIError)
	if !ok || apiErr.Status != 401 || apiErr.Code != "invalid_enrollment_token" {
		t.Fatalf("err = %#v", err)
	}
}
