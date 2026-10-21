// Command opamp-server is the platform's opamp-server service. This milestone (M1.2)
// provides only liveness; protocol handling arrives in M6.
package main

import (
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"time"

	"pcp.local/platform/health"
)

const service = "opamp-server"

func main() {
	port := os.Getenv("OPAMP_PORT")
	if port == "" {
		port = "4320"
	}

	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		if err := health.Probe("http://127.0.0.1:" + port + "/healthz"); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}

	mux := http.NewServeMux()
	mux.Handle("GET /healthz", health.Handler(service))

	srv := &http.Server{Addr: ":" + port, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	slog.Info("listening", "service", service, "port", port)
	if err := srv.ListenAndServe(); err != nil {
		slog.Error("server stopped", "error", err)
		os.Exit(1)
	}
}
