package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/golang/snappy"
)

// Config is the gateway's runtime configuration (D15, master plan §3 limits).
type Config struct {
	VMWriteURL      string
	TrustedProxies  []string
	Resolver        Resolver
	AgentSeriesMax  int
	TenantSeriesMax int
	AgentSamplesPS  float64
	MaxBodyBytes    int
	Now             func() time.Time
	Client          *http.Client
}

// Gateway authenticates agents, rewrites tenant labels, enforces limits, and forwards
// remote_write to VictoriaMetrics.
type Gateway struct {
	cfg     Config
	series  *SeriesLimiter
	samples *SampleLimiter
	mux     *http.ServeMux
}

// Labels that only the gateway may set (BR-04-02).
var reserved = map[string]bool{"tenant_id": true, "product_id": true, "environment_id": true, "agent_id": true}

const futureTolerance = time.Hour

func NewGateway(cfg Config) *Gateway {
	if cfg.Client == nil {
		cfg.Client = &http.Client{Timeout: 30 * time.Second}
	}
	g := &Gateway{
		cfg:     cfg,
		series:  &SeriesLimiter{AgentMax: cfg.AgentSeriesMax, TenantMax: cfg.TenantSeriesMax},
		samples: &SampleLimiter{Rate: cfg.AgentSamplesPS},
		mux:     http.NewServeMux(),
	}
	g.mux.HandleFunc("POST /prometheus/api/v1/write", g.write)
	notYet := func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "OTLP ingest arrives in a later release; use remote_write", http.StatusNotImplemented)
	}
	g.mux.HandleFunc("POST /otlp/v1/metrics", notYet)
	g.mux.HandleFunc("POST /otlp/v1/logs", notYet)
	g.mux.HandleFunc("POST /otlp/v1/traces", notYet)
	return g
}

func (g *Gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) { g.mux.ServeHTTP(w, r) }

// identity trusts X-Client-Cert-Fingerprint only from Caddy's socket address (D10).
func (g *Gateway) identity(r *http.Request) (*Identity, error) {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	host = strings.TrimPrefix(host, "::ffff:")
	trusted := false
	for _, p := range g.cfg.TrustedProxies {
		trusted = trusted || p == host
	}
	fp := strings.ToLower(strings.ReplaceAll(r.Header.Get("X-Client-Cert-Fingerprint"), ":", ""))
	if !trusted || len(fp) != 64 {
		return nil, errUnknownAgent
	}
	return g.cfg.Resolver.Resolve(r.Context(), fp)
}

func (g *Gateway) write(w http.ResponseWriter, r *http.Request) {
	id, err := g.identity(r)
	if err != nil {
		if !errors.Is(err, errUnknownAgent) {
			slog.Error("identity lookup failed", "error", err)
			http.Error(w, "identity lookup unavailable", http.StatusServiceUnavailable)
			return
		}
		http.Error(w, "agent certificate not accepted", http.StatusUnauthorized)
		return
	}
	compressed, err := io.ReadAll(io.LimitReader(r.Body, int64(g.cfg.MaxBodyBytes)+1))
	if err != nil {
		http.Error(w, "read error", http.StatusBadRequest)
		return
	}
	size, err := snappy.DecodedLen(compressed)
	if err != nil {
		http.Error(w, "body is not snappy-compressed", http.StatusBadRequest)
		return
	}
	if size > g.cfg.MaxBodyBytes || len(compressed) > g.cfg.MaxBodyBytes {
		http.Error(w, "request larger than 10 MB", http.StatusRequestEntityTooLarge)
		return
	}
	raw, err := snappy.Decode(nil, compressed)
	if err != nil {
		http.Error(w, "body is not snappy-compressed", http.StatusBadRequest)
		return
	}
	wr, err := decodeWriteRequest(raw)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	now := g.cfg.Now()
	limit := now.Add(futureTolerance).UnixMilli()
	out := &WriteRequest{Series: make([]TimeSeries, 0, len(wr.Series))}
	keys := make([]string, 0, len(wr.Series))
	samples := 0
	for _, ts := range wr.Series {
		kept := ts.Samples[:0]
		for _, s := range ts.Samples {
			if s.Timestamp <= limit {
				kept = append(kept, s)
			}
		}
		if len(kept) == 0 {
			continue
		}
		labels := ts.Labels[:0]
		for _, l := range ts.Labels {
			if !reserved[l.Name] {
				labels = append(labels, l)
			}
		}
		labels = append(labels,
			Label{"agent_id", id.AgentID}, Label{"environment_id", id.EnvironmentID},
			Label{"product_id", id.ProductID}, Label{"tenant_id", id.OrganizationID})
		sort.Slice(labels, func(i, j int) bool { return labels[i].Name < labels[j].Name })
		out.Series = append(out.Series, TimeSeries{Labels: labels, Samples: kept})
		keys = append(keys, seriesKey(labels))
		samples += len(kept)
	}
	if len(out.Series) == 0 {
		http.Error(w, "all samples are more than 1 h in the future; check the host clock", http.StatusBadRequest)
		return
	}
	if !g.series.Admit(now, id.AgentID, id.OrganizationID, keys) {
		w.Header().Set("Retry-After", "60")
		http.Error(w, "active series limit reached; new series refused, existing series continue", http.StatusTooManyRequests)
		return
	}
	if ok, wait := g.samples.Allow(now, id.AgentID, samples); !ok {
		w.Header().Set("Retry-After", strconv.Itoa(int(wait.Seconds()+0.999)))
		http.Error(w, "sample rate limit reached", http.StatusTooManyRequests)
		return
	}
	if err := g.forward(r.Context(), id.OrganizationID, out); err != nil {
		slog.Error("forward to storage failed", "error", err)
		http.Error(w, "storage unavailable; retry", http.StatusServiceUnavailable)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func seriesKey(labels []Label) string {
	var b strings.Builder
	for _, l := range labels {
		b.WriteString(l.Name)
		b.WriteByte(0)
		b.WriteString(l.Value)
		b.WriteByte(0)
	}
	return b.String()
}

// forward sends to VictoriaMetrics with extra_label as defense in depth (D15).
func (g *Gateway) forward(ctx context.Context, tenant string, wr *WriteRequest) error {
	u, err := url.Parse(g.cfg.VMWriteURL)
	if err != nil {
		return err
	}
	q := u.Query()
	q.Set("extra_label", "tenant_id="+tenant)
	u.RawQuery = q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u.String(), bytes.NewReader(snappy.Encode(nil, wr.encode())))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Encoding", "snappy")
	req.Header.Set("Content-Type", "application/x-protobuf")
	req.Header.Set("X-Prometheus-Remote-Write-Version", "0.1.0")
	res, err := g.cfg.Client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, res.Body)
	if res.StatusCode >= 300 {
		return fmt.Errorf("storage answered %d", res.StatusCode)
	}
	return nil
}
