package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHandlerNeedsTheInternalTokenAndCreatesSessions(t *testing.T) {
	m := newTestManager(newReports())
	h := Handler(m, "internal-secret")
	call := func(method, path, token, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}
	body := `{"sessionId":"s1","organizationId":"o1","mode":"key","hosts":[{"id":"h1","host":"10.0.0.1","port":22,"username":"pcp-install"}],"install":{"token":"pcp_enr_x"},"expiresAt":"2999-01-01T00:00:00Z"}`
	if rec := call("POST", "/sessions", "", body); rec.Code != http.StatusUnauthorized {
		t.Fatalf("no token: %d", rec.Code)
	}
	if rec := call("POST", "/sessions", "wrong", body); rec.Code != http.StatusUnauthorized {
		t.Fatalf("wrong token: %d", rec.Code)
	}
	rec := call("POST", "/sessions", "internal-secret", body)
	if rec.Code != http.StatusCreated || !strings.Contains(rec.Body.String(), `"publicKey":"ssh-ed25519 `) {
		t.Fatalf("create: %d %s", rec.Code, rec.Body)
	}
	if strings.Contains(rec.Body.String(), "pcp_enr_x") {
		t.Error("token echoed")
	}
	if rec := call("POST", "/sessions/s1/hosts/h1/confirm", "internal-secret", `{"fingerprint":"SHA256:x"}`); rec.Code != http.StatusConflict {
		t.Fatalf("confirm before connect: %d", rec.Code)
	}
	if rec := call("POST", "/sessions/nope/connect", "internal-secret", `{}`); rec.Code != http.StatusNotFound {
		t.Fatalf("unknown session: %d", rec.Code)
	}
	if rec := call("DELETE", "/sessions/s1", "internal-secret", ""); rec.Code != http.StatusNoContent {
		t.Fatalf("abort: %d", rec.Code)
	}
	if _, ok := m.session("s1"); ok {
		t.Error("session kept after abort")
	}
}
