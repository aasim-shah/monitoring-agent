package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/golang/snappy"
)

var agentA = &Identity{AgentID: "agent-a", OrganizationID: "org-a", ProductID: "prod-a", EnvironmentID: "env-a"}

type fakeResolver map[string]*Identity

func (f fakeResolver) Resolve(_ context.Context, fp string) (*Identity, error) {
	if id, ok := f[fp]; ok {
		return id, nil
	}
	return nil, errUnknownAgent
}

type capture struct {
	mu       sync.Mutex
	urls     []string
	requests []*WriteRequest
	status   int
}

func (c *capture) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	raw, _ := snappy.Decode(nil, body)
	wr, _ := decodeWriteRequest(raw)
	c.mu.Lock()
	c.urls = append(c.urls, r.URL.String())
	c.requests = append(c.requests, wr)
	c.mu.Unlock()
	if c.status != 0 {
		w.WriteHeader(c.status)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

const fp = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func newGateway(t testing.TB, vm http.Handler, mutate func(*Config)) (*Gateway, *time.Time) {
	t.Helper()
	srv := httptest.NewServer(vm)
	t.Cleanup(srv.Close)
	now := time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC)
	cfg := Config{
		VMWriteURL:      srv.URL + "/api/v1/write",
		TrustedProxies:  []string{"172.30.0.10"},
		Resolver:        fakeResolver{fp: agentA},
		AgentSeriesMax:  20_000,
		TenantSeriesMax: 200_000,
		AgentSamplesPS:  10_000,
		MaxBodyBytes:    10 << 20,
		Now:             func() time.Time { return now },
	}
	if mutate != nil {
		mutate(&cfg)
	}
	return NewGateway(cfg), &now
}

func series(name string, n int, ts time.Time, extra ...Label) []TimeSeries {
	out := make([]TimeSeries, n)
	for i := range out {
		labels := append([]Label{{"__name__", name}, {"instance", fmt.Sprintf("i%d", i)}}, extra...)
		out[i] = TimeSeries{Labels: labels, Samples: []Sample{{Value: float64(i), Timestamp: ts.UnixMilli()}}}
	}
	return out
}

func post(t *testing.T, g *Gateway, peer string, wr *WriteRequest) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/prometheus/api/v1/write", bytes.NewReader(snappy.Encode(nil, wr.encode())))
	req.RemoteAddr = peer + ":40000"
	req.Header.Set("X-Client-Cert-Fingerprint", fp)
	req.Header.Set("Content-Encoding", "snappy")
	rec := httptest.NewRecorder()
	g.ServeHTTP(rec, req)
	return rec
}

func labelValue(ts TimeSeries, name string) []string {
	var out []string
	for _, l := range ts.Labels {
		if l.Name == name {
			out = append(out, l.Value)
		}
	}
	return out
}

// Review Focus #1, TC-04-02.
func TestTenantLabelsAreOverwritten(t *testing.T) {
	vm := &capture{}
	g, now := newGateway(t, vm, nil)
	wr := &WriteRequest{Series: series("system_cpu_time_seconds_total", 1, *now,
		Label{"tenant_id", "org-b"}, Label{"product_id", "prod-b"}, Label{"agent_id", "evil"}, Label{"environment_id", "x"})}
	if rec := post(t, g, "172.30.0.10", wr); rec.Code != http.StatusNoContent {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	got := vm.requests[0].Series[0]
	for name, want := range map[string]string{"tenant_id": "org-a", "product_id": "prod-a", "environment_id": "env-a", "agent_id": "agent-a"} {
		if v := labelValue(got, name); len(v) != 1 || v[0] != want {
			t.Errorf("%s = %v, want [%s]", name, v, want)
		}
	}
	for i := 1; i < len(got.Labels); i++ {
		if got.Labels[i-1].Name >= got.Labels[i].Name {
			t.Fatalf("labels not sorted: %v", got.Labels)
		}
	}
	u, _ := url.Parse(vm.urls[0])
	if u.Query().Get("extra_label") != "tenant_id=org-a" {
		t.Errorf("forward URL %s lacks extra_label tenant_id=org-a", vm.urls[0])
	}
}

func TestOnlyTheTrustedProxyMayAssertAFingerprint(t *testing.T) {
	g, now := newGateway(t, &capture{}, nil)
	wr := &WriteRequest{Series: series("up", 1, *now)}
	if rec := post(t, g, "10.0.0.5", wr); rec.Code != http.StatusUnauthorized {
		t.Fatalf("untrusted peer: status %d", rec.Code)
	}
	g2, _ := newGateway(t, &capture{}, func(c *Config) { c.Resolver = fakeResolver{} })
	if rec := post(t, g2, "172.30.0.10", wr); rec.Code != http.StatusUnauthorized {
		t.Fatalf("unknown agent: status %d", rec.Code)
	}
}

// TC-04-03 / BR-04-04: at the limit, new series are refused but known ones keep flowing.
func TestSeriesLimit(t *testing.T) {
	vm := &capture{}
	g, now := newGateway(t, vm, nil)
	full := &WriteRequest{Series: series("m", 20_000, *now)}
	if rec := post(t, g, "172.30.0.10", full); rec.Code != http.StatusNoContent {
		t.Fatalf("20,000 series: status %d", rec.Code)
	}
	extra := &WriteRequest{Series: series("other", 1, *now)}
	rec := post(t, g, "172.30.0.10", extra)
	if rec.Code != http.StatusTooManyRequests || rec.Header().Get("Retry-After") == "" {
		t.Fatalf("new series over limit: status %d retry-after %q", rec.Code, rec.Header().Get("Retry-After"))
	}
	known := &WriteRequest{Series: series("m", 5, now.Add(time.Minute))}
	if rec := post(t, g, "172.30.0.10", known); rec.Code != http.StatusNoContent {
		t.Fatalf("known series after limit: status %d", rec.Code)
	}
	*now = now.Add(time.Hour)
	if rec := post(t, g, "172.30.0.10", extra); rec.Code != http.StatusNoContent {
		t.Fatalf("new series in the next hour: status %d", rec.Code)
	}
}

func TestSampleRateLimit(t *testing.T) {
	g, now := newGateway(t, &capture{}, func(c *Config) { c.AgentSamplesPS = 100 })
	// Burst allows 10 s worth (1,000 samples).
	if rec := post(t, g, "172.30.0.10", &WriteRequest{Series: series("m", 1_000, *now)}); rec.Code != http.StatusNoContent {
		t.Fatalf("within burst: status %d", rec.Code)
	}
	rec := post(t, g, "172.30.0.10", &WriteRequest{Series: series("m", 10, *now)})
	if rec.Code != http.StatusTooManyRequests || rec.Header().Get("Retry-After") == "" {
		t.Fatalf("over rate: status %d", rec.Code)
	}
	*now = now.Add(time.Second)
	if rec := post(t, g, "172.30.0.10", &WriteRequest{Series: series("m", 10, *now)}); rec.Code != http.StatusNoContent {
		t.Fatalf("after refill: status %d", rec.Code)
	}
}

// BR-04-10.
func TestFutureSamplesAreDropped(t *testing.T) {
	vm := &capture{}
	g, now := newGateway(t, vm, nil)
	future := series("m", 1, now.Add(2*time.Hour))
	if rec := post(t, g, "172.30.0.10", &WriteRequest{Series: future}); rec.Code != http.StatusBadRequest {
		t.Fatalf("all-future request: status %d", rec.Code)
	}
	mixed := append(series("ok", 1, *now), future...)
	if rec := post(t, g, "172.30.0.10", &WriteRequest{Series: mixed}); rec.Code != http.StatusNoContent {
		t.Fatalf("mixed request: status %d", rec.Code)
	}
	if n := len(vm.requests[len(vm.requests)-1].Series); n != 1 {
		t.Fatalf("forwarded %d series, want 1", n)
	}
}

func TestOversizedBodyAndBackendErrors(t *testing.T) {
	g, now := newGateway(t, &capture{}, func(c *Config) { c.MaxBodyBytes = 1024 })
	if rec := post(t, g, "172.30.0.10", &WriteRequest{Series: series("m", 200, *now)}); rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized: status %d", rec.Code)
	}
	g2, now2 := newGateway(t, &capture{status: http.StatusInternalServerError}, nil)
	if rec := post(t, g2, "172.30.0.10", &WriteRequest{Series: series("m", 1, *now2)}); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("backend 500: status %d", rec.Code)
	}
}

func TestOTLPNotImplementedYet(t *testing.T) {
	g, _ := newGateway(t, &capture{}, nil)
	rec := httptest.NewRecorder()
	g.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/otlp/v1/metrics", strings.NewReader("")))
	if rec.Code != http.StatusNotImplemented {
		t.Fatalf("status %d", rec.Code)
	}
}

func TestWriteRequestRoundTrip(t *testing.T) {
	in := &WriteRequest{Series: []TimeSeries{{Labels: []Label{{"__name__", "a"}, {"x", "é"}}, Samples: []Sample{{1.5, 123}, {-2, 456}}}}}
	out, err := decodeWriteRequest(in.encode())
	if err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(out) != fmt.Sprint(in) {
		t.Fatalf("round trip: %v != %v", out, in)
	}
	if _, err := decodeWriteRequest([]byte{0xff, 0xff}); err == nil {
		t.Fatal("garbage decoded")
	}
}

// Review Focus #2, TC-04-04: replays do not double-count (needs VictoriaMetrics; the
// harness sets PCP_VM_URL to a container started with -dedup.minScrapeInterval=1s).
func TestReplayIsDeduplicatedByVictoriaMetrics(t *testing.T) {
	vmURL := os.Getenv("PCP_VM_URL")
	if vmURL == "" {
		t.Skip("PCP_VM_URL not set")
	}
	now := time.Now().Truncate(time.Second)
	g := NewGateway(Config{
		VMWriteURL: vmURL + "/api/v1/write", TrustedProxies: []string{"172.30.0.10"},
		Resolver: fakeResolver{fp: agentA}, AgentSeriesMax: 20_000, TenantSeriesMax: 200_000,
		AgentSamplesPS: 10_000, MaxBodyBytes: 10 << 20, Now: time.Now,
	})
	name := fmt.Sprintf("replay_test_%d", now.UnixNano())
	wr := &WriteRequest{Series: []TimeSeries{{
		Labels: []Label{{"__name__", name}},
		// Older than VictoriaMetrics' default 30 s search latency offset.
		Samples: []Sample{{1, now.Add(-90 * time.Second).UnixMilli()}, {2, now.Add(-75 * time.Second).UnixMilli()}},
	}}}
	for i := 0; i < 3; i++ {
		if rec := post(t, g, "172.30.0.10", wr); rec.Code != http.StatusNoContent {
			t.Fatalf("write %d: %d", i, rec.Code)
		}
	}
	_, _ = http.Get(vmURL + "/internal/force_flush")
	q := url.Values{"query": {fmt.Sprintf("count_over_time(%s[5m])", name)}, "time": {fmt.Sprint(now.Unix())}}
	var body string
	for i := 0; i < 20 && !strings.Contains(body, `"value"`); i++ {
		res, err := http.Get(vmURL + "/api/v1/query?" + q.Encode())
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(res.Body)
		res.Body.Close()
		body = string(b)
		time.Sleep(500 * time.Millisecond)
	}
	if !strings.Contains(body, `"2"]`) {
		t.Fatalf("count after 3 replays: %s (want 2 samples)", body)
	}
	if !strings.Contains(body, `"tenant_id":"org-a"`) {
		t.Fatalf("stored series lacks tenant_id: %s", body)
	}
}
