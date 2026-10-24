package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"sync"
)

// TenantUsage is one tenant's telemetry since the last report (M10.6, spec §11.6).
// ActiveSeries is the number of distinct series admitted this hour, a level; the rest count up.
type TenantUsage struct {
	OrganizationID        string `json:"organizationId"`
	ActiveSeries          int    `json:"activeSeries"`
	Samples               int64  `json:"samples"`
	RefusedSeriesRequests int64  `json:"refusedSeriesRequests"`
	RefusedRateRequests   int64  `json:"refusedRateRequests"`
}

type usageCounters struct {
	mu      sync.Mutex
	tenants map[string]*TenantUsage
}

func (c *usageCounters) add(tenant string, f func(*TenantUsage)) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.tenants == nil {
		c.tenants = map[string]*TenantUsage{}
	}
	u := c.tenants[tenant]
	if u == nil {
		u = &TenantUsage{OrganizationID: tenant}
		c.tenants[tenant] = u
	}
	f(u)
}

// TakeUsage returns the usage of every tenant that sent or was refused anything since the last
// call, and starts a new window.
func (g *Gateway) TakeUsage() []TenantUsage {
	g.usage.mu.Lock()
	taken := g.usage.tenants
	g.usage.tenants = nil
	g.usage.mu.Unlock()
	out := make([]TenantUsage, 0, len(taken))
	for _, u := range taken {
		u.ActiveSeries = g.series.Active(g.cfg.Now(), u.OrganizationID)
		out = append(out, *u)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].OrganizationID < out[j].OrganizationID })
	return out
}

// restoreUsage puts back counts a failed report could not deliver.
func (g *Gateway) restoreUsage(us []TenantUsage) {
	for _, u := range us {
		g.usage.add(u.OrganizationID, func(t *TenantUsage) {
			t.Samples += u.Samples
			t.RefusedSeriesRequests += u.RefusedSeriesRequests
			t.RefusedRateRequests += u.RefusedRateRequests
		})
	}
}

// UsageReporter posts usage to the API's internal endpoint (X-Internal-Token), every minute.
type UsageReporter struct {
	BaseURL string
	Token   string
	Client  *http.Client
	Gateway *Gateway
}

func (r *UsageReporter) Report(ctx context.Context) error {
	usage := r.Gateway.TakeUsage()
	if len(usage) == 0 {
		return nil
	}
	body, err := json.Marshal(map[string]any{"tenants": usage})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.BaseURL+"/internal/v1/telemetry-usage", bytes.NewReader(body))
	if err != nil {
		r.Gateway.restoreUsage(usage)
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Internal-Token", r.Token)
	res, err := r.Client.Do(req)
	if err != nil {
		r.Gateway.restoreUsage(usage)
		return fmt.Errorf("usage report: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		r.Gateway.restoreUsage(usage)
		return fmt.Errorf("usage report: API answered %d", res.StatusCode)
	}
	return nil
}
