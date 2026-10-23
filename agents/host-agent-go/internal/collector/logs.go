package collector

import "strconv"

// Log lines are counted, never shipped: the count connector turns them into
// log.lines{service,level} and log.pattern{service,pattern} (spec §11.8, M11.2).
const (
	errorPattern = `(?i)\b(error|err|fatal|crit|critical|panic|emerg|severe)\b|"s":"[EF]"`
	warnPattern  = `(?i)\b(warn|warning)\b|"s":"W"`
	oomPattern   = `(?i)out of memory|oom-killer|OOMKilled`
	stackPattern = `^\s+at |^Traceback`
	// nginx access lines carry no level; a 5xx status counts as an error.
	nginx5xxPattern = `"\s5\d\d\s`
)

func matches(pattern string) string {
	return "body matches " + strconv.Quote(pattern)
}

func add(id, field, value, output string) map[string]any {
	op := map[string]any{"id": id, "type": "add", "field": field, "value": value}
	if output != "" {
		op["output"] = output
	}
	return op
}

func logOperators(pack string) []any {
	errorExpr := errorPattern
	if pack == "nginx" {
		errorExpr = errorPattern + "|" + nginx5xxPattern
	}
	return []any{
		add("service", "attributes.service", pack, ""),
		map[string]any{"id": "level", "type": "router", "default": "level_info", "routes": []any{
			map[string]any{"expr": matches(errorExpr), "output": "level_error"},
			map[string]any{"expr": matches(warnPattern), "output": "level_warn"},
		}},
		add("level_error", "attributes.level", "error", "pattern"),
		add("level_warn", "attributes.level", "warn", "pattern"),
		add("level_info", "attributes.level", "info", "pattern"),
		map[string]any{"id": "pattern", "type": "router", "default": "done", "routes": []any{
			map[string]any{"expr": matches(oomPattern), "output": "pattern_oom"},
			map[string]any{"expr": matches(stackPattern), "output": "pattern_stacktrace"},
		}},
		add("pattern_oom", "attributes.pattern", "oom", "done"),
		add("pattern_stacktrace", "attributes.pattern", "stacktrace", "done"),
		map[string]any{"id": "done", "type": "noop"},
	}
}

// addLogReceivers adds a filelog receiver per pack with log files and returns their IDs.
func addLogReceivers(receivers map[string]any, packs []PackConfig, files func(string) []string) []string {
	if files == nil {
		return nil
	}
	var ids []string
	for _, p := range packs {
		paths := files(p.ID)
		if len(paths) == 0 {
			continue
		}
		id := "filelog/" + p.ID
		receivers[id] = map[string]any{
			"include":           paths,
			"start_at":          "end",
			"include_file_name": false,
			"operators":         logOperators(p.ID),
		}
		ids = append(ids, id)
	}
	return ids
}

func countConnector() map[string]any {
	key := func(k string) map[string]any { return map[string]any{"key": k} }
	return map[string]any{"logs": map[string]any{
		"log.lines": map[string]any{
			"description": "Log lines by service and level",
			"attributes":  []any{key("service"), key("level")},
		},
		"log.pattern": map[string]any{
			"description": "Out-of-memory and stack-trace lines by service",
			"conditions":  []string{`attributes["pattern"] != nil`},
			"attributes":  []any{key("service"), key("pattern")},
		},
	}}
}
