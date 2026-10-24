package main

import (
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// logs forwards an agent's retained log lines (OTLP/HTTP, already redacted on the host) to
// VictoriaLogs under the agent's tenant (M18.1, BR-12-08). AccountID comes from the certificate's
// tenant; the agent's own headers and fields cannot choose another.
func (g *Gateway) logs(w http.ResponseWriter, r *http.Request) {
	if g.cfg.VLogsURL == "" {
		http.Error(w, "retained logs are not enabled on this platform", http.StatusNotFound)
		return
	}
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
	body, err := io.ReadAll(io.LimitReader(r.Body, int64(g.cfg.MaxBodyBytes)+1))
	if err != nil {
		http.Error(w, "cannot read body", http.StatusBadRequest)
		return
	}
	if len(body) > g.cfg.MaxBodyBytes {
		http.Error(w, "body too large", http.StatusRequestEntityTooLarge)
		return
	}
	// extra_fields override fields of the same name in the records.
	q := url.Values{"extra_fields": {strings.Join([]string{
		"tenant_id=" + id.OrganizationID,
		"product_id=" + id.ProductID,
		"environment_id=" + id.EnvironmentID,
		"agent_id=" + id.AgentID,
	}, ",")}}
	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost,
		strings.TrimRight(g.cfg.VLogsURL, "/")+"/insert/opentelemetry/v1/logs?"+q.Encode(), strings.NewReader(string(body)))
	if err != nil {
		http.Error(w, "cannot forward", http.StatusInternalServerError)
		return
	}
	for _, h := range []string{"Content-Type", "Content-Encoding"} {
		if v := r.Header.Get(h); v != "" {
			req.Header.Set(h, v)
		}
	}
	req.Header.Set("AccountID", strconv.FormatUint(uint64(id.LogsAccountID), 10))
	req.Header.Set("ProjectID", "0")
	res, err := g.cfg.Client.Do(req)
	if err != nil {
		slog.Warn("logs forward failed", "error", err)
		http.Error(w, "log storage unavailable", http.StatusServiceUnavailable)
		return
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		slog.Warn("logs refused by storage", "status", res.StatusCode)
		http.Error(w, fmt.Sprintf("log storage answered %d", res.StatusCode), http.StatusBadGateway)
		return
	}
	w.WriteHeader(http.StatusOK)
}
