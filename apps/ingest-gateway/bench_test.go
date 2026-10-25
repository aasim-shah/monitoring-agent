package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/golang/snappy"
)

// BenchmarkWrite measures the gateway's write path (M19.2 load baseline): authenticate, decode,
// relabel 500 series, enforce limits, re-encode, and forward. Storage is a no-op server, so this is
// the gateway's own cost per request. Run: scripts/go.sh test -run x -bench . ./apps/ingest-gateway/
func BenchmarkWrite(b *testing.B) {
	g, now := newGateway(b, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}), func(c *Config) { c.AgentSamplesPS = 1e12 })
	body := snappy.Encode(nil, (&WriteRequest{Series: series("system_cpu_time_seconds_total", 500, *now)}).encode())
	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		req := httptest.NewRequest(http.MethodPost, "/prometheus/api/v1/write", bytes.NewReader(body))
		req.RemoteAddr = "172.30.0.10:40000"
		req.Header.Set("X-Client-Cert-Fingerprint", fp)
		req.Header.Set("Content-Encoding", "snappy")
		rec := httptest.NewRecorder()
		g.ServeHTTP(rec, req)
		if rec.Code != http.StatusNoContent {
			b.Fatalf("status %d: %s", rec.Code, rec.Body)
		}
	}
	b.ReportMetric(float64(500*b.N)/b.Elapsed().Seconds(), "samples/s")
}
