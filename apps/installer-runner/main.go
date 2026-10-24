// Command installer-runner performs opt-in assisted SSH installs (spec §4.12, §8.11). It keeps
// session keys, passwords, and enrollment tokens in memory only, runs only the fixed install and
// cleanup commands, and reports each host's progress to the control API.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"pcp.local/platform/health"
)

const service = "installer-runner"

func main() {
	port := os.Getenv("RUNNER_PORT")
	if port == "" {
		port = "8090"
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
	api := strings.TrimRight(required("API_INTERNAL_URL"), "/")
	token := required("INTERNAL_TOKEN")
	client := &http.Client{Timeout: 10 * time.Second}
	m := NewManager(func(sessionID, hostID string, u Update) {
		// Status only in the log; output and fingerprints go to the API.
		slog.Info("host update", "session", sessionID, "host", hostID, "status", u.Status)
		body, _ := json.Marshal(u)
		req, err := http.NewRequestWithContext(context.Background(), http.MethodPost,
			api+"/internal/v1/install-sessions/"+sessionID+"/hosts/"+hostID, bytes.NewReader(body))
		if err != nil {
			return
		}
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		res, err := client.Do(req)
		if err != nil {
			slog.Warn("report failed", "session", sessionID, "error", err)
			return
		}
		_ = res.Body.Close()
		if res.StatusCode >= 300 {
			slog.Warn("report refused", "session", sessionID, "status", res.StatusCode)
		}
	})
	go func() {
		for range time.Tick(time.Minute) {
			m.Expire()
		}
	}()
	mux := http.NewServeMux()
	mux.Handle("GET /healthz", health.Handler(service))
	mux.Handle("/", Handler(m, token))
	srv := &http.Server{Addr: ":" + port, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	slog.Info("listening", "service", service, "port", port)
	if err := srv.ListenAndServe(); err != nil {
		slog.Error("server stopped", "error", err)
		os.Exit(1)
	}
}
