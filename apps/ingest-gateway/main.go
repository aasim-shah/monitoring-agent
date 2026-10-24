// Command ingest-gateway accepts agent telemetry (D15): it authenticates the agent by
// client-certificate fingerprint, overwrites tenant labels, enforces limits, and forwards
// to VictoriaMetrics.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"pcp.local/platform/health"
)

const service = "ingest-gateway"

func main() {
	port := os.Getenv("INGEST_PORT")
	if port == "" {
		port = "4318"
	}

	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		if err := health.Probe("http://127.0.0.1:" + port + "/healthz"); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}

	required := func(name string) string {
		v := os.Getenv(name)
		if v == "" {
			slog.Error("missing required setting", "name", name)
			os.Exit(1)
		}
		return v
	}
	gateway := NewGateway(Config{
		VMWriteURL:     required("VM_WRITE_URL"),
		TrustedProxies: strings.Split(required("TRUSTED_PROXY_ADDRESSES"), ","),
		Resolver: &APIResolver{
			BaseURL: strings.TrimRight(required("API_INTERNAL_URL"), "/"),
			Token:   required("INTERNAL_TOKEN"),
			Client:  &http.Client{Timeout: 5 * time.Second},
			Now:     time.Now,
		},
		AgentSeriesMax:  20_000,
		TenantSeriesMax: 200_000,
		AgentSamplesPS:  10_000,
		MaxBodyBytes:    10 << 20,
		Now:             time.Now,
		// Retained logs (M18.1) are off unless VictoriaLogs is configured.
		VLogsURL: os.Getenv("VLOGS_URL"),
	})

	// Per-tenant usage to the API every minute (M10.6); a failed report is retried with the next.
	reporter := &UsageReporter{
		BaseURL: strings.TrimRight(required("API_INTERNAL_URL"), "/"),
		Token:   required("INTERNAL_TOKEN"),
		Client:  &http.Client{Timeout: 10 * time.Second},
		Gateway: gateway,
	}
	go func() {
		for range time.Tick(time.Minute) {
			if err := reporter.Report(context.Background()); err != nil {
				slog.Warn("usage report failed", "error", err)
			}
		}
	}()

	mux := http.NewServeMux()
	mux.Handle("GET /healthz", health.Handler(service))
	mux.Handle("/", gateway)

	srv := &http.Server{Addr: ":" + port, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	slog.Info("listening", "service", service, "port", port)
	if err := srv.ListenAndServe(); err != nil {
		slog.Error("server stopped", "error", err)
		os.Exit(1)
	}
}
