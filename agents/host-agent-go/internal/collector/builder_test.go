package collector

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// Every component a generated config names must be compiled into pcp-otelcol, or the agent's collector
// refuses the whole config (a pack then fails on every host).
func TestEveryComponentIsInTheCollectorBuild(t *testing.T) {
	manifest, err := os.ReadFile("../../collector/builder-config.yaml")
	if err != nil {
		t.Fatal(err)
	}
	built := map[string]bool{}
	for _, m := range regexp.MustCompile(`gomod: \S+/(\w+) v`).FindAllStringSubmatch(string(manifest), -1) {
		name := m[1]
		for _, kind := range []string{"receiver", "processor", "connector", "exporter", "extension"} {
			name = strings.TrimSuffix(name, kind)
		}
		built[name] = true
	}
	cfg := logsConfig(t,
		PackConfig{ID: "redis", Settings: map[string]any{"endpoint": "127.0.0.1:6379"}},
		PackConfig{ID: "postgresql", Settings: map[string]any{"endpoint": "127.0.0.1:5432"}, Credentials: map[string]string{"username": "u", "password": "p"}},
		PackConfig{ID: "mysql", Settings: map[string]any{"endpoint": "127.0.0.1:3306"}, Credentials: map[string]string{"username": "u", "password": "p"}},
		PackConfig{ID: "mongodb", Settings: map[string]any{"endpoint": "127.0.0.1:27017"}},
		PackConfig{ID: "kafka", Settings: map[string]any{"endpoint": "127.0.0.1:9092"}},
		PackConfig{ID: "nginx", Settings: map[string]any{"endpoint": "http://127.0.0.1/nginx_status"}},
		PackConfig{ID: "nodejs", Settings: map[string]any{}},
	)
	for _, section := range []string{"receivers", "processors", "connectors", "exporters", "extensions"} {
		comps, _ := cfg[section].(map[string]any)
		for id := range comps {
			typ := strings.ReplaceAll(strings.SplitN(id, "/", 2)[0], "_", "")
			if !built[typ] {
				t.Errorf("%s %q is not in builder-config.yaml", section, id)
			}
		}
	}
}
