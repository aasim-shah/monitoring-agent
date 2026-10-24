package collector

import (
	"fmt"
	"sort"
	"strings"
)

// PackConfig is one enabled monitoring pack: settings from the dashboard and the
// credentials the agent opened from the sealed box (written only to the 0600 config file).
type PackConfig struct {
	ID          string            `json:"id"`
	Settings    map[string]any    `json:"settings"`
	Credentials map[string]string `json:"credentials,omitempty"`
	// RetainLogs ships the pack's log lines, redacted, to retained-log storage (M18.1).
	RetainLogs bool `json:"retainLogs,omitempty"`
}

type packReceiver struct {
	name   string // receiver ID in the collector configuration
	prefix string // metric name prefix kept by the allowlist
	build  func(endpoint string, creds map[string]string) map[string]any
}

const packInterval = "30s"

// BoostInterval is a live-boosted pack's collection interval (BR-11-08).
const BoostInterval = "5s"

func withCreds(cfg map[string]any, creds map[string]string, keys ...string) map[string]any {
	for _, k := range keys {
		if v := creds[k]; v != "" {
			cfg[k] = v
		}
	}
	return cfg
}

var packReceivers = map[string]packReceiver{
	"redis": {"redis", "redis", func(ep string, c map[string]string) map[string]any {
		return withCreds(map[string]any{"endpoint": ep, "collection_interval": packInterval}, c, "username", "password")
	}},
	"postgresql": {"postgresql", "postgresql", func(ep string, c map[string]string) map[string]any {
		// Loopback by default; TLS off unless the operator points it elsewhere (M11 adds a toggle).
		return withCreds(map[string]any{"endpoint": ep, "transport": "tcp", "collection_interval": packInterval, "tls": map[string]any{"insecure": true}}, c, "username", "password")
	}},
	"mysql": {"mysql", "mysql", func(ep string, c map[string]string) map[string]any {
		return withCreds(map[string]any{"endpoint": ep, "collection_interval": packInterval}, c, "username", "password")
	}},
	"mongodb": {"mongodb", "mongodb", func(ep string, c map[string]string) map[string]any {
		return withCreds(map[string]any{"hosts": []map[string]any{{"endpoint": ep}}, "collection_interval": packInterval, "tls": map[string]any{"insecure": true}}, c, "username", "password")
	}},
	"kafka": {"kafka_metrics", "kafka", func(ep string, _ map[string]string) map[string]any {
		return map[string]any{"brokers": []string{ep}, "scrapers": []string{"brokers", "topics", "consumers"}, "collection_interval": packInterval}
	}},
	"nginx": {"nginx", "nginx", func(ep string, _ map[string]string) map[string]any {
		return map[string]any{"endpoint": ep, "collection_interval": packInterval}
	}},
	"nodejs": {"host_metrics/nodejs", "process", func(string, map[string]string) map[string]any {
		return map[string]any{
			"collection_interval": packInterval,
			"scrapers": map[string]any{"process": map[string]any{
				"include":                 map[string]any{"names": []string{"^(node|nodejs)$"}, "match_type": "regexp"},
				"mute_process_all_errors": true,
				"metrics":                 map[string]any{"process.cpu.utilization": map[string]any{"enabled": true}},
				// pid and executable name label each process; command lines may carry secrets.
				"resource_attributes": map[string]any{
					"process.command":         map[string]any{"enabled": false},
					"process.command_line":    map[string]any{"enabled": false},
					"process.executable.path": map[string]any{"enabled": false},
					"process.owner":           map[string]any{"enabled": false},
					"process.parent_pid":      map[string]any{"enabled": false},
				},
			}},
		}
	}},
}

// addPacks adds each pack's receiver and returns the receiver IDs and the metric prefixes to keep.
// level2 are the extra receivers a pack adds for Level 2 guided setups (spec §8.9, UC-11-04):
// the customer's change sends or exposes richer metrics on loopback, and the agent picks them up.
type level2 struct {
	receivers map[string]map[string]any
	prefixes  []string // dotted OTLP metric prefixes kept by the allowlist
	keep      []string // whole-name patterns kept (scraped Prometheus metrics)
}

var level2Receivers = map[string]level2{
	// OpenTelemetry Node.js SDK → the agent's OTLP/HTTP receiver, loopback only (BR-11-07).
	"nodejs": {
		receivers: map[string]map[string]any{
			"otlp/app": {"protocols": map[string]any{"http": map[string]any{"endpoint": "127.0.0.1:4318"}}},
		},
		prefixes: []string{"http", "v8js", "nodejs"},
	},
	// The JMX exporter javaagent on the broker, bound to 127.0.0.1:7071.
	"kafka": {
		receivers: map[string]map[string]any{
			"prometheus/kafka_jmx": {"config": map[string]any{"scrape_configs": []any{map[string]any{
				"job_name":        "kafka-jmx",
				"scrape_interval": packInterval,
				"static_configs":  []any{map[string]any{"targets": []string{"127.0.0.1:7071"}}},
			}}}},
		},
		keep: []string{`^kafka_(server|network|controller|log)_`},
	},
}

func addPacks(receivers map[string]any, packs []PackConfig, boosted map[string]bool) ([]string, []string, error) {
	ids, prefixes, _, err := addPacksKeep(receivers, packs, boosted)
	return ids, prefixes, err
}

func addPacksKeep(receivers map[string]any, packs []PackConfig, boosted map[string]bool) ([]string, []string, []string, error) {
	var ids, keep []string
	prefixes := []string{"system", "process"}
	for _, p := range packs {
		r, ok := packReceivers[p.ID]
		if !ok {
			return nil, nil, nil, fmt.Errorf("unknown pack %q", p.ID)
		}
		endpoint, _ := p.Settings["endpoint"].(string)
		if endpoint == "" && p.ID != "nodejs" {
			return nil, nil, nil, fmt.Errorf("pack %s: endpoint is required", p.ID)
		}
		recv := r.build(endpoint, p.Credentials)
		if boosted[p.ID] {
			recv["collection_interval"] = BoostInterval
		}
		receivers[r.name] = recv
		ids = append(ids, r.name)
		if !contains(prefixes, r.prefix) {
			prefixes = append(prefixes, r.prefix)
		}
		if l2, ok := level2Receivers[p.ID]; ok {
			for _, name := range sortedKeys(l2.receivers) {
				receivers[name] = l2.receivers[name]
				ids = append(ids, name)
			}
			for _, pre := range l2.prefixes {
				if !contains(prefixes, pre) {
					prefixes = append(prefixes, pre)
				}
			}
			keep = append(keep, l2.keep...)
		}
	}
	return ids, prefixes, keep, nil
}

func sortedKeys(m map[string]map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// allowlist drops every metric outside the enabled prefixes (BR-11-06). OTTL drops
// what the condition matches; `[.]` avoids escaping a backslash through JSON and OTTL.
// Extra patterns keep whole metric names (the scraped log counts).
func allowlist(prefixes []string, keep ...string) map[string]any {
	cond := fmt.Sprintf(`not IsMatch(name, "^(%s)[.]")`, strings.Join(prefixes, "|"))
	for _, k := range keep {
		cond += fmt.Sprintf(` and not IsMatch(name, "%s")`, k)
	}
	return map[string]any{
		"error_mode": "ignore",
		"metrics":    map[string]any{"metric": []string{cond}},
	}
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}
