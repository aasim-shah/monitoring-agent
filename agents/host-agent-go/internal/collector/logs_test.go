package collector

import (
	"encoding/json"
	"regexp"
	"strings"
	"testing"
)

var testLogFiles = map[string][]string{
	"redis": {"/var/log/redis/redis-server.log"},
	"nginx": {"/var/log/nginx/access.log", "/var/log/nginx/error.log"},
}

func logsConfig(t *testing.T, packs ...PackConfig) map[string]any {
	t.Helper()
	raw, err := Config(Input{
		IngestURL: "https://ingest.example.com", CertFile: "c", KeyFile: "k", StorageDir: "/s", Packs: packs,
		LogFiles: func(id string) []string { return testLogFiles[id] },
	})
	if err != nil {
		t.Fatal(err)
	}
	var cfg map[string]any
	if err := json.Unmarshal(raw, &cfg); err != nil {
		t.Fatal(err)
	}
	return cfg
}

func operatorsByID(t *testing.T, recv map[string]any) map[string]map[string]any {
	t.Helper()
	out := map[string]map[string]any{}
	for _, o := range recv["operators"].([]any) {
		op := o.(map[string]any)
		out[op["id"].(string)] = op
	}
	return out
}

// Expressions in router routes are expr-lang `matches` with a Go regexp; pull it out to test it.
func routeRegexp(t *testing.T, router map[string]any, output string) *regexp.Regexp {
	t.Helper()
	for _, r := range router["routes"].([]any) {
		route := r.(map[string]any)
		if route["output"] == output {
			expr := route["expr"].(string)
			quoted := strings.TrimPrefix(expr, "body matches ")
			var pattern string
			if err := json.Unmarshal([]byte(quoted), &pattern); err != nil {
				t.Fatalf("expr %q: %v", expr, err)
			}
			return regexp.MustCompile(pattern)
		}
	}
	t.Fatalf("no route to %s in %v", output, router)
	return nil
}

func TestPackLogFilesBecomeLogCounts(t *testing.T) {
	cfg := logsConfig(t,
		PackConfig{ID: "redis", Settings: map[string]any{"endpoint": "127.0.0.1:6379"}},
		PackConfig{ID: "nginx", Settings: map[string]any{"endpoint": "http://127.0.0.1/status"}},
		PackConfig{ID: "nodejs", Settings: map[string]any{}},
	)
	recv := cfg["receivers"].(map[string]any)
	redis := recv["filelog/redis"].(map[string]any)
	if redis["start_at"] != "end" {
		t.Errorf("start_at = %v", redis["start_at"])
	}
	if inc := redis["include"].([]any); len(inc) != 1 || inc[0] != "/var/log/redis/redis-server.log" {
		t.Errorf("include = %v", inc)
	}
	if _, ok := recv["filelog/nodejs"]; ok {
		t.Error("nodejs has no file sources and must not get a filelog receiver")
	}
	ops := operatorsByID(t, redis)
	if s := ops["service"]; s["type"] != "add" || s["field"] != "attributes.service" || s["value"] != "redis" {
		t.Errorf("service operator = %v", s)
	}
	level := ops["level"]
	errRe := routeRegexp(t, level, "level_error")
	warnRe := routeRegexp(t, level, "level_warn")
	for _, line := range []string{
		"1:M 23 Oct 2026 10:00:00.000 # Error accepting a client connection",
		"2026-10-23 10:00:00 UTC [123] FATAL:  password authentication failed",
		"[ERROR] [MY-010119] Aborting",
		`{"t":{"$date":"2026-10-23"},"s":"E","c":"NETWORK","msg":"x"}`,
	} {
		if !errRe.MatchString(line) {
			t.Errorf("not an error: %q", line)
		}
	}
	if errRe.MatchString("1:M 23 Oct 2026 * Ready to accept connections") {
		t.Error("an ordinary line counted as an error")
	}
	if !warnRe.MatchString("2026/10/23 [warn] 12#12: conflicting server name") {
		t.Error("warn not detected")
	}
	if ops["level_info"]["value"] != "info" || ops["level_error"]["value"] != "error" {
		t.Errorf("level values: %v %v", ops["level_info"], ops["level_error"])
	}
	pattern := ops["pattern"]
	if !routeRegexp(t, pattern, "pattern_oom").MatchString("Out of memory: Killed process 42 (redis-server)") {
		t.Error("OOM not detected")
	}
	stack := routeRegexp(t, pattern, "pattern_stacktrace")
	if !stack.MatchString("    at Object.<anonymous> (/app/index.js:1:1)") || !stack.MatchString("Traceback (most recent call last):") {
		t.Error("stack trace not detected")
	}
	// nginx access lines count 5xx responses as errors.
	ngx := operatorsByID(t, recv["filelog/nginx"].(map[string]any))
	if !routeRegexp(t, ngx["level"], "level_error").MatchString(`1.2.3.4 - - [23/Oct/2026:10:00:00 +0000] "GET / HTTP/1.1" 502 157 "-" "curl"`) {
		t.Error("nginx 502 not counted as an error")
	}

	count := cfg["connectors"].(map[string]any)["count"].(map[string]any)["logs"].(map[string]any)
	lines := count["log.lines"].(map[string]any)
	if keys := attributeKeys(lines); keys != "service,level" {
		t.Errorf("log.lines attributes = %s", keys)
	}
	pat := count["log.pattern"].(map[string]any)
	if keys := attributeKeys(pat); keys != "service,pattern" {
		t.Errorf("log.pattern attributes = %s", keys)
	}
	if c := pat["conditions"].([]any); len(c) != 1 || c[0] != `attributes["pattern"] != nil` {
		t.Errorf("log.pattern conditions = %v", c)
	}

	pipes := cfg["service"].(map[string]any)["pipelines"].(map[string]any)
	logs := pipes["logs"].(map[string]any)
	if strings.Join(toStrings(logs["receivers"]), ",") != "filelog/redis,filelog/nginx" {
		t.Errorf("logs receivers = %v", logs["receivers"])
	}
	if strings.Join(toStrings(logs["exporters"]), ",") != "count" {
		t.Errorf("logs exporters = %v", logs["exporters"])
	}
	// Counts arrive only with new lines; a loopback exporter holds the totals and the
	// collector scrapes them every 30 s, so sparse errors still yield steady samples.
	counts := pipes["metrics/logcounts"].(map[string]any)
	if strings.Join(toStrings(counts["receivers"]), ",") != "count" ||
		strings.Join(toStrings(counts["exporters"]), ",") != "prometheus/logcounts" {
		t.Errorf("metrics/logcounts = %v", counts)
	}
	exp := cfg["exporters"].(map[string]any)["prometheus/logcounts"].(map[string]any)
	if exp["endpoint"] != "127.0.0.1:13134" {
		t.Errorf("log counts exporter must listen on loopback only: %v", exp)
	}
	scrape := recv["prometheus/logcounts"].(map[string]any)["config"].(map[string]any)["scrape_configs"].([]any)[0].(map[string]any)
	target := scrape["static_configs"].([]any)[0].(map[string]any)["targets"].([]any)[0]
	if scrape["scrape_interval"] != "30s" || target != "127.0.0.1:13134" {
		t.Errorf("scrape = %v", scrape)
	}
	metrics := pipes["metrics"].(map[string]any)
	if !contains(toStrings(metrics["receivers"]), "prometheus/logcounts") || contains(toStrings(metrics["receivers"]), "count") {
		t.Errorf("metrics receivers = %v", metrics["receivers"])
	}
	filter := cfg["processors"].(map[string]any)["filter/allowlist"].(map[string]any)
	conds := filter["metrics"].(map[string]any)["metric"].([]any)
	cond := conds[0].(string)
	if !strings.Contains(cond, `not IsMatch(name, "^log_(lines|pattern)_total$")`) {
		t.Errorf("allowlist must keep the scraped log counts: %s", cond)
	}
}

func TestNoLogFilesNoLogsPipeline(t *testing.T) {
	cfg := logsConfig(t, PackConfig{ID: "nodejs", Settings: map[string]any{}})
	pipes := cfg["service"].(map[string]any)["pipelines"].(map[string]any)
	if _, ok := pipes["logs"]; ok {
		t.Error("logs pipeline without file sources")
	}
	if _, ok := cfg["connectors"]; ok {
		t.Error("count connector without file sources")
	}
	if contains(toStrings(pipes["metrics"].(map[string]any)["receivers"]), "prometheus/logcounts") {
		t.Error("log counts scrape without file sources")
	}
}

func attributeKeys(m map[string]any) string {
	var keys []string
	for _, a := range m["attributes"].([]any) {
		keys = append(keys, a.(map[string]any)["key"].(string))
	}
	return strings.Join(keys, ",")
}
