package logs

import (
	"os"
	"path/filepath"

	"pcp.local/hostagent/internal/collector"
)

// Source kinds.
const (
	KindFile    = "file"
	KindJournal = "journal"
)

// Source is something the viewer may tail. Requests carry the ID only; paths come from here.
type Source struct {
	ID    string
	Label string
	Kind  string
	// Paths are tried in order (globs allowed); the first existing file is tailed.
	Paths []string
	// Match narrows the journal (e.g. "_COMM=node", "_SYSTEMD_UNIT=redis-server.service").
	Match string
}

// packSources lists log sources per monitoring pack (WB-12 §4). Order is display order.
var packSources = map[string][]Source{
	"redis": {{ID: "redis.server", Label: "Redis server log", Kind: KindFile, Paths: []string{
		"/var/log/redis/redis-server.log", "/var/log/redis/redis.log", "/var/log/redis.log"}}},
	"postgresql": {{ID: "postgresql.main", Label: "PostgreSQL log", Kind: KindFile, Paths: []string{
		"/var/log/postgresql/postgresql-*-main.log", "/var/lib/pgsql/data/log/*.log"}}},
	"mysql": {{ID: "mysql.error", Label: "MySQL error log", Kind: KindFile, Paths: []string{
		"/var/log/mysql/error.log", "/var/log/mysqld.log"}}},
	"mongodb": {{ID: "mongodb.main", Label: "MongoDB log", Kind: KindFile, Paths: []string{
		"/var/log/mongodb/mongod.log", "/var/log/mongodb/mongodb.log"}}},
	"kafka": {{ID: "kafka.server", Label: "Kafka server log", Kind: KindFile, Paths: []string{
		"/opt/kafka/logs/server.log", "/var/log/kafka/server.log", "/usr/local/kafka/logs/server.log"}}},
	"nginx": {
		{ID: "nginx.access", Label: "nginx access log", Kind: KindFile, Paths: []string{"/var/log/nginx/access.log"}},
		{ID: "nginx.error", Label: "nginx error log", Kind: KindFile, Paths: []string{"/var/log/nginx/error.log"}},
	},
	"nodejs": {{ID: "nodejs.journal", Label: "Node.js processes (journal)", Kind: KindJournal, Match: "_COMM=node"}},
}

var hostJournal = Source{ID: "host.journal", Label: "System journal", Kind: KindJournal}

var packOrder = []string{"redis", "postgresql", "mysql", "mongodb", "kafka", "nginx", "nodejs"}

// Sources returns what may be tailed on this host: the applied packs' sources and the
// system journal. Anything else is refused (WB-12 allowlist).
func Sources(applied []collector.PackConfig) []Source {
	have := map[string]bool{}
	for _, p := range applied {
		have[p.ID] = true
	}
	var out []Source
	for _, id := range packOrder {
		if have[id] {
			out = append(out, packSources[id]...)
		}
	}
	return append(out, hostJournal)
}

// Find looks a source up by ID within the allowed list.
func Find(allowed []Source, id string) (Source, bool) {
	for _, s := range allowed {
		if s.ID == id {
			return s, true
		}
	}
	return Source{}, false
}

// Resolve returns the file to tail for a file source.
func Resolve(src Source) (string, bool) {
	for _, pattern := range src.Paths {
		matches, err := filepath.Glob(pattern)
		if err != nil {
			continue
		}
		for _, m := range matches {
			if info, err := os.Stat(m); err == nil && info.Mode().IsRegular() {
				return m, true
			}
		}
	}
	return "", false
}

// FilePaths returns every concrete file path a pack's sources may use (collector filelog include).
func FilePaths(packID string) []string {
	var out []string
	for _, s := range packSources[packID] {
		if s.Kind == KindFile {
			out = append(out, s.Paths...)
		}
	}
	return out
}

func journalArgs(src Source) []string {
	args := []string{"-f", "-n", "0", "-o", "cat"}
	if src.Match != "" {
		args = append(args, src.Match)
	}
	return args
}
