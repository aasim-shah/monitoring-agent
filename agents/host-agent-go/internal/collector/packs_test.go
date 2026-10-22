package collector

import (
	"encoding/json"
	"strings"
	"testing"
)

func packConfig(t *testing.T, packs ...PackConfig) (map[string]any, string) {
	t.Helper()
	raw, err := Config(Input{IngestURL: "https://ingest.example.com", CertFile: "c", KeyFile: "k", StorageDir: "/s", Packs: packs})
	if err != nil {
		t.Fatal(err)
	}
	var cfg map[string]any
	if err := json.Unmarshal(raw, &cfg); err != nil {
		t.Fatal(err)
	}
	return cfg, string(raw)
}

func pipeline(cfg map[string]any) map[string]any {
	return cfg["service"].(map[string]any)["pipelines"].(map[string]any)["metrics"].(map[string]any)
}

func TestPackReceiversCarryCredentialsOnlyInTheFile(t *testing.T) {
	cfg, raw := packConfig(t,
		PackConfig{ID: "redis", Settings: map[string]any{"endpoint": "127.0.0.1:6379"}},
		PackConfig{ID: "postgresql", Settings: map[string]any{"endpoint": "127.0.0.1:5432"}, Credentials: map[string]string{"username": "mon", "password": "s3cret"}},
		PackConfig{ID: "nodejs", Settings: map[string]any{}},
	)
	recv := cfg["receivers"].(map[string]any)
	pg := recv["postgresql"].(map[string]any)
	if pg["endpoint"] != "127.0.0.1:5432" || pg["username"] != "mon" || pg["password"] != "s3cret" || pg["transport"] != "tcp" {
		t.Errorf("postgresql = %v", pg)
	}
	redis := recv["redis"].(map[string]any)
	if _, ok := redis["password"]; ok {
		t.Errorf("redis without credentials must not set a password: %v", redis)
	}
	if _, ok := recv["host_metrics/nodejs"].(map[string]any)["scrapers"].(map[string]any)["process"]; !ok {
		t.Error("nodejs uses the host_metrics process scraper")
	}
	got := strings.Join(toStrings(pipeline(cfg)["receivers"]), ",")
	if got != "host_metrics,redis,postgresql,host_metrics/nodejs" {
		t.Errorf("pipeline receivers = %s", got)
	}
	if strings.Count(raw, "s3cret") != 1 {
		t.Error("the password must appear exactly once, in its receiver")
	}
}

func TestFilterAllowlistsEnabledPacks(t *testing.T) {
	cfg, _ := packConfig(t, PackConfig{ID: "redis", Settings: map[string]any{"endpoint": "127.0.0.1:6379"}})
	procs := toStrings(pipeline(cfg)["processors"])
	if procs[0] != "memory_limiter" || procs[1] != "filter/allowlist" || procs[len(procs)-1] != "batch" {
		t.Errorf("processors = %v (memory_limiter first, allowlist, batch last; BR-11-06)", procs)
	}
	conds := cfg["processors"].(map[string]any)["filter/allowlist"].(map[string]any)["metrics"].(map[string]any)["metric"].([]any)
	if len(conds) != 1 || conds[0] != `not IsMatch(name, "^(system|process|redis)[.]")` {
		t.Errorf("allowlist = %v", conds)
	}
	host, _ := packConfig(t)
	if c := host["processors"].(map[string]any)["filter/allowlist"].(map[string]any)["metrics"].(map[string]any)["metric"].([]any); c[0] != `not IsMatch(name, "^(system|process)[.]")` {
		t.Errorf("host-only allowlist = %v", c)
	}
}

func TestEveryPackBuildsAReceiver(t *testing.T) {
	for _, p := range []PackConfig{
		{ID: "mysql", Settings: map[string]any{"endpoint": "127.0.0.1:3306"}, Credentials: map[string]string{"username": "u", "password": "p"}},
		{ID: "mongodb", Settings: map[string]any{"endpoint": "127.0.0.1:27017"}},
		{ID: "kafka", Settings: map[string]any{"endpoint": "127.0.0.1:9092"}},
		{ID: "nginx", Settings: map[string]any{"endpoint": "http://127.0.0.1/nginx_status"}},
	} {
		cfg, _ := packConfig(t, p)
		if n := len(toStrings(pipeline(cfg)["receivers"])); n != 2 {
			t.Errorf("%s: %d receivers", p.ID, n)
		}
	}
	if _, err := Config(Input{Packs: []PackConfig{{ID: "docker"}}}); err == nil {
		t.Error("unknown pack accepted")
	}
	if _, err := Config(Input{Packs: []PackConfig{{ID: "redis", Settings: map[string]any{}}}}); err == nil {
		t.Error("pack without endpoint accepted")
	}
}

func toStrings(v any) []string {
	var out []string
	for _, s := range v.([]any) {
		out = append(out, s.(string))
	}
	return out
}
