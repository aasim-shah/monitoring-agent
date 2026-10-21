// Package health provides the /healthz handler and container health probe
// shared by the platform's Go services.
package health

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// Handler returns 200 {"status":"ok","service":<service>} for liveness checks.
func Handler(service string) http.Handler {
	body, _ := json.Marshal(map[string]string{"status": "ok", "service": service})
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(body)
	})
}

// Probe GETs url and returns an error unless the response is 200 within 2 s.
// Services expose it as a `healthcheck` subcommand for container health checks.
func Probe(url string) error {
	client := http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("health probe %s: status %d", url, resp.StatusCode)
	}
	return nil
}
