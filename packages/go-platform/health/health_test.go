package health

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHandlerReturnsOK(t *testing.T) {
	rec := httptest.NewRecorder()
	Handler("ingest-gateway").ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if body["status"] != "ok" || body["service"] != "ingest-gateway" {
		t.Fatalf("body = %v", body)
	}
}

func TestProbeSucceedsAgainstHealthyServer(t *testing.T) {
	srv := httptest.NewServer(Handler("opamp-server"))
	defer srv.Close()

	if err := Probe(srv.URL + "/healthz"); err != nil {
		t.Fatalf("Probe() = %v, want nil", err)
	}
}

func TestProbeFailsOnClosedPort(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := l.Addr().String()
	l.Close()

	if err := Probe("http://" + addr + "/healthz"); err == nil {
		t.Fatal("Probe() = nil, want error")
	}
}

func TestProbeFailsOnNon200(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	if err := Probe(srv.URL); err == nil {
		t.Fatal("Probe() = nil, want error for 503")
	}
}
