// Package collector writes pcp-otelcol's configuration and keeps the collector running
// (master plan M6.1/M6.2; OpAMP takes over configuration in M6b).
package collector

import (
	"encoding/json"
	"path/filepath"
	"strings"
)

// Input is what the agent knows after enrollment.
type Input struct {
	IngestURL string // e.g. https://ingest.example.com
	CertFile  string
	KeyFile   string
	// CAFile and ServerName are only for development stacks with a private TLS root.
	CAFile     string
	ServerName string
	StorageDir string // remote_write WAL lives under it
	Packs      []PackConfig
	// LogFiles returns a pack's log file paths (globs allowed); their lines are counted
	// into log.lines and log.pattern. Nil means no log-derived metrics.
	LogFiles func(packID string) []string
}

// Config returns the collector configuration as JSON (a subset of YAML, so the
// collector reads it unchanged). Host metrics every 30 s, one receiver per enabled
// pack, memory_limiter first, a metric allowlist, remote_write over mTLS with an
// on-disk WAL, and no non-loopback listener.
func Config(in Input) ([]byte, error) {
	// Re-read the certificate periodically so a rotation (every 20 days) is picked up.
	tls := map[string]any{"cert_file": in.CertFile, "key_file": in.KeyFile, "reload_interval": "5m"}
	if in.CAFile != "" {
		tls["ca_file"] = in.CAFile
	}
	if in.ServerName != "" {
		tls["server_name_override"] = in.ServerName
	}
	enabled := map[string]any{"enabled": true}
	receivers := map[string]any{
		"host_metrics": map[string]any{
			"collection_interval": "30s",
			"scrapers": map[string]any{
				"cpu":        map[string]any{"metrics": map[string]any{"system.cpu.utilization": enabled}},
				"memory":     map[string]any{"metrics": map[string]any{"system.memory.utilization": enabled}},
				"filesystem": map[string]any{"metrics": map[string]any{"system.filesystem.utilization": enabled}},
				"network":    map[string]any{},
				"load":       map[string]any{},
				"disk":       map[string]any{},
			},
		},
	}
	packIDs, prefixes, err := addPacks(receivers, in.Packs)
	if err != nil {
		return nil, err
	}
	logIDs := addLogReceivers(receivers, in.Packs, in.LogFiles)
	metricsReceivers := append([]string{"host_metrics"}, packIDs...)
	metricsProcessors := []string{"memory_limiter", "filter/allowlist", "resource_detection", "batch"}
	processors := map[string]any{
		"memory_limiter": map[string]any{"check_interval": "1s", "limit_mib": 100, "spike_limit_mib": 20},
		"resource_detection": map[string]any{
			"detectors": []string{"system"},
			"system":    map[string]any{"hostname_sources": []string{"os"}},
		},
		"batch": map[string]any{"timeout": "10s"},
	}
	pipelines := map[string]any{}
	exporters := map[string]any{}
	filter := allowlist(prefixes)
	if len(logIDs) > 0 {
		// The count connector emits only when lines arrive. A loopback Prometheus exporter
		// keeps the running totals and the collector scrapes them every 30 s, so a burst of
		// errors becomes a steady counter that rate() can read.
		pipelines["logs"] = map[string]any{
			"receivers":  logIDs,
			"processors": []string{"memory_limiter"},
			"exporters":  []string{"count"},
		}
		pipelines["metrics/logcounts"] = map[string]any{
			"receivers": []string{"count"},
			"exporters": []string{"prometheus/logcounts"},
		}
		exporters["prometheus/logcounts"] = map[string]any{
			"endpoint":          logCountsEndpoint,
			"metric_expiration": "720h",
		}
		receivers["prometheus/logcounts"] = logCountsScrape()
		metricsReceivers = append(metricsReceivers, "prometheus/logcounts")
		filter = allowlist(prefixes, `^log_(lines|pattern)_total$`)
	}
	processors["filter/allowlist"] = filter
	pipelines["metrics"] = map[string]any{
		"receivers":  metricsReceivers,
		"processors": metricsProcessors,
		"exporters":  []string{"prometheus_remote_write"},
	}
	cfg := map[string]any{
		"extensions": map[string]any{
			"health_check": map[string]any{"endpoint": "127.0.0.1:13133"},
		},
		"receivers":  receivers,
		"processors": processors,
		"exporters":  exporters,
	}
	exporters["prometheus_remote_write"] = map[string]any{
		// The gateway adds agent, product, environment, and tenant labels (BR-04-02).
		"endpoint":             strings.TrimRight(in.IngestURL, "/") + "/prometheus/api/v1/write",
		"tls":                  tls,
		"retry_on_failure":     enabled,
		"wal":                  map[string]any{"directory": filepath.Join(in.StorageDir, "wal")},
		"remote_write_queue":   map[string]any{"enabled": true, "queue_size": 10000},
		"max_batch_size_bytes": 3000000,
		"target_info":          map[string]any{"enabled": false},
		// Resource attributes (host.name, process.pid, …) become labels.
		"resource_to_telemetry_conversion": enabled,
	}
	cfg["service"] = map[string]any{
		"extensions": []string{"health_check"},
		"telemetry":  map[string]any{"metrics": map[string]any{"level": "none"}},
		"pipelines":  pipelines,
	}
	if len(logIDs) > 0 {
		cfg["connectors"] = map[string]any{"count": countConnector()}
	}
	return json.MarshalIndent(cfg, "", "  ")
}
