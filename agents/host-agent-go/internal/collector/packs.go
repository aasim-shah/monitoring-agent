package collector

import (
	"fmt"
	"strings"
)

// PackConfig is one enabled monitoring pack: settings from the dashboard and the
// credentials the agent opened from the sealed box (written only to the 0600 config file).
type PackConfig struct {
	ID          string            `json:"id"`
	Settings    map[string]any    `json:"settings"`
	Credentials map[string]string `json:"credentials,omitempty"`
}

type packReceiver struct {
	name   string // receiver ID in the collector configuration
	prefix string // metric name prefix kept by the allowlist
	build  func(endpoint string, creds map[string]string) map[string]any
}

const packInterval = "30s"

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
			}},
		}
	}},
}

// addPacks adds each pack's receiver and returns the receiver IDs and the metric prefixes to keep.
func addPacks(receivers map[string]any, packs []PackConfig) ([]string, []string, error) {
	var ids []string
	prefixes := []string{"system", "process"}
	for _, p := range packs {
		r, ok := packReceivers[p.ID]
		if !ok {
			return nil, nil, fmt.Errorf("unknown pack %q", p.ID)
		}
		endpoint, _ := p.Settings["endpoint"].(string)
		if endpoint == "" && p.ID != "nodejs" {
			return nil, nil, fmt.Errorf("pack %s: endpoint is required", p.ID)
		}
		receivers[r.name] = r.build(endpoint, p.Credentials)
		ids = append(ids, r.name)
		if !contains(prefixes, r.prefix) {
			prefixes = append(prefixes, r.prefix)
		}
	}
	return ids, prefixes, nil
}

// allowlist drops every metric outside the enabled prefixes (BR-11-06). OTTL drops
// what the condition matches; `[.]` avoids escaping a backslash through JSON and OTTL.
func allowlist(prefixes []string) map[string]any {
	return map[string]any{
		"error_mode": "ignore",
		"metrics": map[string]any{
			"metric": []string{fmt.Sprintf(`not IsMatch(name, "^(%s)[.]")`, strings.Join(prefixes, "|"))},
		},
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
