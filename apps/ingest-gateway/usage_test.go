package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// M10.6, spec §11.6: per-tenant usage (active series, samples, refusals) is visible.
func TestUsageCountsAcceptedSamplesAndRefusals(t *testing.T) {
	g, now := newGateway(t, &capture{}, func(c *Config) { c.AgentSeriesMax = 3 })
	post(t, g, "172.30.0.10", &WriteRequest{Series: series("m", 3, *now)})
	if rec := post(t, g, "172.30.0.10", &WriteRequest{Series: series("other", 1, *now)}); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("over the series limit: %d", rec.Code)
	}
	u := g.TakeUsage()
	if len(u) != 1 {
		t.Fatalf("usage = %+v", u)
	}
	want := TenantUsage{OrganizationID: "org-a", ActiveSeries: 3, Samples: 3, RefusedSeriesRequests: 1}
	if u[0] != want {
		t.Errorf("usage = %+v, want %+v", u[0], want)
	}
	// Counters reset after a report; active series is a level, not a counter.
	post(t, g, "172.30.0.10", &WriteRequest{Series: series("m", 2, now.Add(time.Minute))})
	if u := g.TakeUsage(); u[0].Samples != 2 || u[0].ActiveSeries != 3 || u[0].RefusedSeriesRequests != 0 {
		t.Errorf("second report = %+v", u[0])
	}
}

func TestUsageReporterSendsWithTheInternalToken(t *testing.T) {
	var got struct {
		Tenants []TenantUsage `json:"tenants"`
	}
	var token string
	fail := false
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/internal/v1/telemetry-usage" || r.Method != http.MethodPost {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		token = r.Header.Get("X-Internal-Token")
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &got)
		if fail {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer api.Close()
	g, now := newGateway(t, &capture{}, nil)
	post(t, g, "172.30.0.10", &WriteRequest{Series: series("m", 4, *now)})
	r := &UsageReporter{BaseURL: api.URL, Token: "tok", Client: api.Client(), Gateway: g}

	fail = true
	if err := r.Report(context.Background()); err == nil {
		t.Fatal("a failed report must return an error")
	}
	// The failed window is kept and sent with the next report.
	fail = false
	if err := r.Report(context.Background()); err != nil {
		t.Fatal(err)
	}
	if token != "tok" || len(got.Tenants) != 1 || got.Tenants[0].Samples != 4 || got.Tenants[0].OrganizationID != "org-a" {
		t.Errorf("token %q, tenants %+v", token, got.Tenants)
	}
	// Nothing new: nothing to send.
	got.Tenants = nil
	if err := r.Report(context.Background()); err != nil || got.Tenants != nil {
		t.Errorf("empty report sent %+v (err %v)", got.Tenants, err)
	}
}
