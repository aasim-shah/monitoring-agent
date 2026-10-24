package main

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"
)

type logsCapture struct {
	mu      sync.Mutex
	headers []http.Header
	queries []url.Values
	bodies  [][]byte
}

func (c *logsCapture) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	c.mu.Lock()
	c.headers = append(c.headers, r.Header.Clone())
	c.queries = append(c.queries, r.URL.Query())
	c.bodies = append(c.bodies, body)
	c.mu.Unlock()
	if r.URL.Path != "/insert/opentelemetry/v1/logs" {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	w.WriteHeader(http.StatusOK)
}

func postLogs(g *Gateway, peer string, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/v1/logs", bytes.NewReader([]byte("otlp-protobuf-bytes")))
	req.RemoteAddr = peer + ":40000"
	req.Header.Set("X-Client-Cert-Fingerprint", fp)
	req.Header.Set("Content-Type", "application/x-protobuf")
	req.Header.Set("Content-Encoding", "gzip")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	g.ServeHTTP(rec, req)
	return rec
}

// M18.1, BR-12-08: the gateway stamps the tenant's AccountID and the agent's fields; nothing the
// agent sends can choose another tenant.
func TestRetainedLogsAreStampedWithTheAgentsTenant(t *testing.T) {
	vl := &logsCapture{}
	srv := httptest.NewServer(vl)
	defer srv.Close()
	agent := *agentA
	agent.LogsAccountID = 7
	g, _ := newGateway(t, &capture{}, func(c *Config) {
		c.VLogsURL = srv.URL
		c.Resolver = fakeResolver{fp: &agent}
	})
	rec := postLogs(g, "172.30.0.10", map[string]string{"AccountID": "1", "ProjectID": "9"})
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	h, q := vl.headers[0], vl.queries[0]
	if h.Get("AccountID") != "7" || h.Get("ProjectID") != "0" {
		t.Errorf("tenant headers = %q/%q", h.Get("AccountID"), h.Get("ProjectID"))
	}
	if h.Get("Content-Encoding") != "gzip" || h.Get("Content-Type") != "application/x-protobuf" || string(vl.bodies[0]) != "otlp-protobuf-bytes" {
		t.Errorf("body or encoding changed: %v %q", h, vl.bodies[0])
	}
	if got := q.Get("extra_fields"); got != "tenant_id=org-a,product_id=prod-a,environment_id=env-a,agent_id=agent-a" {
		t.Errorf("extra_fields = %q", got)
	}
}

func TestRetainedLogsRefuseUnknownAgentsAndAreOffWithoutStorage(t *testing.T) {
	vl := &logsCapture{}
	srv := httptest.NewServer(vl)
	defer srv.Close()
	g, _ := newGateway(t, &capture{}, func(c *Config) { c.VLogsURL = srv.URL })
	if rec := postLogs(g, "10.9.9.9", nil); rec.Code != http.StatusUnauthorized {
		t.Errorf("untrusted peer: %d", rec.Code)
	}
	off, _ := newGateway(t, &capture{}, nil)
	if rec := postLogs(off, "172.30.0.10", nil); rec.Code != http.StatusNotFound {
		t.Errorf("without storage: %d", rec.Code)
	}
	if len(vl.headers) != 0 {
		t.Error("forwarded a refused request")
	}
}
