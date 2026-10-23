package logs

import (
	"context"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"pcp.local/hostagent/internal/collector"
)

type posted struct {
	mu     sync.Mutex
	chunks []struct {
		seq   int64
		lines []string
		final bool
	}
}

func (p *posted) post(seq int64, lines []string, final bool) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.chunks = append(p.chunks, struct {
		seq   int64
		lines []string
		final bool
	}{seq, lines, final})
	return nil
}

func TestRunTaskRefusesSourcesOutsideTheAllowlist(t *testing.T) {
	p := &posted{}
	for _, payload := range []map[string]any{
		{"source": "nginx.access", "sessionId": "s"},
		{"source": "/etc/shadow", "sessionId": "s"},
		{"sessionId": "s"},
	} {
		_, err := RunTask(context.Background(), payload, []collector.PackConfig{{ID: "redis"}}, p.post, Options{})
		if err == nil || !strings.Contains(err.Error(), "not allowed") {
			t.Errorf("payload %v: err = %v", payload, err)
		}
	}
	if len(p.chunks) != 0 {
		t.Error("a refused task posted lines")
	}
}

func TestRunTaskStreamsThenSendsAFinalChunk(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "redis-server.log")
	appendLines(t, path)
	saved := packSources["redis"]
	packSources["redis"] = []Source{{ID: "redis.server", Kind: KindFile, Paths: []string{path}}}
	defer func() { packSources["redis"] = saved }()

	p := &posted{}
	ctx, cancel := context.WithTimeout(context.Background(), 700*time.Millisecond)
	defer cancel()
	go func() {
		time.Sleep(150 * time.Millisecond)
		appendLines(t, path, "ready to accept connections tcp")
	}()
	result, err := RunTask(ctx, map[string]any{"source": "redis.server", "sessionId": "s"}, []collector.PackConfig{{ID: "redis"}}, p.post,
		Options{Flush: 50 * time.Millisecond, Poll: 20 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	if result["lines"] != 1 {
		t.Errorf("result = %v", result)
	}
	last := p.chunks[len(p.chunks)-1]
	if !last.final || p.chunks[0].lines[0] != "ready to accept connections tcp" || p.chunks[0].seq != 0 || last.seq != int64(len(p.chunks)-1) {
		t.Errorf("chunks = %+v", p.chunks)
	}
}
