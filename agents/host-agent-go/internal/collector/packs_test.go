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
	if got != "host_metrics,redis,postgresql,host_metrics/nodejs,otlp/app" {
		t.Errorf("pipeline receivers = %s", got)
	}
	if strings.Count(raw, "s3cret") != 1 {
		t.Error("the password must appear exactly once, in its receiver")
	}
}

func TestFilterAllowlistsEnabledPacks(t *testing.T) {
	cfg, _ := packConfig(t, PackConfig{ID: "redis", Settings: map[string]any{"endpoint": "127.0.0.1:6379"}})
	procs := toStrings(pipeline(cfg)["processors"])
	if procs[0] != "memory_limiter" || procs[1] != "transform/drop_labels" || procs[2] != "filter/allowlist" || procs[len(procs)-1] != "batch" {
		t.Errorf("processors = %v (memory_limiter first, drop labels, allowlist, batch last; BR-11-06)", procs)
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
		// host_metrics, the pack's receiver, and for kafka the Level 2 JMX scrape.
		want := 2
		if p.ID == "kafka" {
			want = 3
		}
		if n := len(toStrings(pipeline(cfg)["receivers"])); n != want {
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

// Per-process labels come from resource attributes; command lines may carry secrets.
func TestNodeProcessesAreLabelledWithoutCommandLines(t *testing.T) {
	cfg, _ := packConfig(t, PackConfig{ID: "nodejs", Settings: map[string]any{}})
	proc := cfg["receivers"].(map[string]any)["host_metrics/nodejs"].(map[string]any)["scrapers"].(map[string]any)["process"].(map[string]any)
	attrs := proc["resource_attributes"].(map[string]any)
	for _, a := range []string{"process.command", "process.command_line", "process.executable.path", "process.owner", "process.parent_pid"} {
		if attrs[a].(map[string]any)["enabled"] != false {
			t.Errorf("%s must be disabled", a)
		}
	}
	exp := cfg["exporters"].(map[string]any)["prometheus_remote_write"].(map[string]any)
	if exp["resource_to_telemetry_conversion"].(map[string]any)["enabled"] != true {
		t.Error("resource attributes (process.pid, process.executable.name) must become labels")
	}
}

// Spec §11.6: the edge drops per-user and per-request labels and normalizes routes, in every config.
func TestEveryConfigDropsHighCardinalityLabels(t *testing.T) {
	for name, packs := range map[string][]PackConfig{
		"host only": nil,
		"redis":     {{ID: "redis", Settings: map[string]any{"endpoint": "127.0.0.1:6379"}}},
		"nodejs":    {{ID: "nodejs", Settings: map[string]any{}}},
	} {
		cfg, raw := packConfig(t, packs...)
		procs := toStrings(pipeline(cfg)["processors"])
		if procs[1] != "transform/drop_labels" {
			t.Errorf("%s: processors = %v", name, procs)
		}
		for _, label := range []string{"user_id", "session_id", "request_id", "trace_id", "span_id", "url.full", "http.url", "http.target", "url.query"} {
			if !strings.Contains(raw, `delete_key(attributes, \"`+label+`\")`) {
				t.Errorf("%s: %s is not dropped", name, label)
			}
		}
		for _, attr := range []string{"http.route", "url.path"} {
			if !strings.Contains(raw, `replace_pattern(attributes[\"`+attr+`\"]`) {
				t.Errorf("%s: %s is not normalized", name, attr)
			}
		}
	}
}

// UC-11-04 Level 2: an app instrumented with the OpenTelemetry SDK sends to the agent on loopback only.
func TestNodejsPackAcceptsOTLPOnLoopbackOnly(t *testing.T) {
	cfg, raw := packConfig(t, PackConfig{ID: "nodejs", Settings: map[string]any{}})
	recv := cfg["receivers"].(map[string]any)["otlp/app"].(map[string]any)
	http := recv["protocols"].(map[string]any)["http"].(map[string]any)
	if http["endpoint"] != "127.0.0.1:4318" {
		t.Errorf("otlp endpoint = %v (loopback only, BR-11-07)", http["endpoint"])
	}
	if !strings.Contains(strings.Join(toStrings(pipeline(cfg)["receivers"]), ","), "otlp/app") {
		t.Error("otlp/app feeds the metrics pipeline")
	}
	if !strings.Contains(raw, `^(system|process|http|v8js|nodejs)[.]`) {
		t.Errorf("the allowlist keeps http, v8js, and nodejs metrics")
	}
}

// UC-11-04 Level 2 (Kafka JVM): the platform scrapes the JMX exporter the customer adds on 127.0.0.1:7071.
func TestKafkaPackScrapesTheJMXExporterOnLoopback(t *testing.T) {
	cfg, raw := packConfig(t, PackConfig{ID: "kafka", Settings: map[string]any{"endpoint": "127.0.0.1:9092"}})
	if _, ok := cfg["receivers"].(map[string]any)["prometheus/kafka_jmx"]; !ok {
		t.Fatal("no JMX scrape receiver")
	}
	if !strings.Contains(raw, `"127.0.0.1:7071"`) || !strings.Contains(raw, `not IsMatch(name, \"^kafka_(server|network|controller|log)_\")`) {
		t.Error("scrapes 127.0.0.1:7071 and keeps the JMX kafka_* metrics")
	}
}

// M18.3: a Level 1 exporter pack scrapes the managed exporter on loopback and keeps its metrics.
func TestExporterPacksScrapeTheManagedExporter(t *testing.T) {
	cfg, raw := packConfig(t,
		PackConfig{ID: "redis-exporter", Settings: map[string]any{"endpoint": "127.0.0.1:9121"}},
		PackConfig{ID: "kafka-exporter", Settings: map[string]any{"endpoint": "127.0.0.1:9308"}},
	)
	recv := cfg["receivers"].(map[string]any)
	for name, target := range map[string]string{"prometheus/redis-exporter": "127.0.0.1:9121", "prometheus/kafka-exporter": "127.0.0.1:9308"} {
		r, ok := recv[name]
		if !ok {
			t.Fatalf("no %s receiver", name)
		}
		if b, _ := json.Marshal(r); !strings.Contains(string(b), `"targets":["`+target+`"]`) {
			t.Errorf("%s: %s", name, b)
		}
	}
	for _, keep := range []string{`^redis_`, `^kafka_(brokers|topic_|consumergroup_)`} {
		if !strings.Contains(raw, keep) {
			t.Errorf("allowlist does not keep %s", keep)
		}
	}
	if got := toStrings(pipeline(cfg)["receivers"]); len(got) != 3 {
		t.Errorf("receivers = %v", got)
	}
}
