package logs

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"pcp.local/hostagent/internal/collector"
)

type collect struct {
	mu    sync.Mutex
	lines []string
	sends int
	err   error
}

func (c *collect) send(lines []string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.lines = append(c.lines, lines...)
	c.sends++
	return c.err
}

func (c *collect) snapshot() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.lines...)
}

func waitFor(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if ok() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func appendLines(t *testing.T, path string, lines ...string) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	for _, l := range lines {
		fmt.Fprintln(f, l)
	}
}

func fileSource(path string) Source {
	return Source{ID: "test.file", Kind: KindFile, Paths: []string{path}}
}

func start(t *testing.T, src Source, c *collect) (context.CancelFunc, chan error) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- Stream(ctx, src, c.send, Options{Rate: 200, Flush: 100 * time.Millisecond, Poll: 20 * time.Millisecond})
	}()
	t.Cleanup(cancel)
	return cancel, done
}

func TestStreamSendsNewLinesRedacted(t *testing.T) {
	path := filepath.Join(t.TempDir(), "redis.log")
	appendLines(t, path, "old line before the tail started")
	c := &collect{}
	start(t, fileSource(path), c)
	time.Sleep(100 * time.Millisecond)
	appendLines(t, path, "AUTH ok password=hunter2 for jane@example.com", "ready")
	waitFor(t, "two lines", func() bool { return len(c.snapshot()) >= 2 })
	got := c.snapshot()
	if got[0] != "AUTH ok password=[REDACTED] for [EMAIL]" || got[1] != "ready" {
		t.Errorf("lines = %q", got)
	}
	for _, l := range got {
		if strings.Contains(l, "old line") {
			t.Error("history was sent; the tail starts at the end")
		}
	}
}

func TestStreamCapsTheRateAndReportsDrops(t *testing.T) {
	path := filepath.Join(t.TempDir(), "noisy.log")
	appendLines(t, path)
	c := &collect{}
	start(t, fileSource(path), c)
	time.Sleep(60 * time.Millisecond)
	burst := make([]string, 1000)
	for i := range burst {
		burst[i] = fmt.Sprintf("line %d", i)
	}
	appendLines(t, path, burst...)
	time.Sleep(1100 * time.Millisecond)
	got := c.snapshot()
	real := 0
	marker := false
	for _, l := range got {
		if strings.HasPrefix(l, "[pcp] dropped ") {
			marker = true
		} else {
			real++
		}
	}
	if real > 240 || real == 0 {
		t.Errorf("sent %d lines in ~1 s, cap 200/s", real)
	}
	if !marker {
		t.Error("no dropped-lines marker")
	}
}

func TestStreamFollowsRotation(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "app.log")
	appendLines(t, path, "x")
	c := &collect{}
	start(t, fileSource(path), c)
	time.Sleep(60 * time.Millisecond)
	if err := os.Rename(path, path+".1"); err != nil {
		t.Fatal(err)
	}
	appendLines(t, path, "after rename")
	waitFor(t, "line after rename", func() bool { return strings.Contains(strings.Join(c.snapshot(), "\n"), "after rename") })
	if err := os.Truncate(path, 0); err != nil {
		t.Fatal(err)
	}
	// Truncation is noticed when the file is shorter than what was read (like tail -F), so the
	// writer must not outgrow the old size within one poll.
	time.Sleep(100 * time.Millisecond)
	appendLines(t, path, "after truncate")
	waitFor(t, "line after truncate", func() bool { return strings.Contains(strings.Join(c.snapshot(), "\n"), "after truncate") })
}

func TestStreamStopsWhenTheSessionCloses(t *testing.T) {
	path := filepath.Join(t.TempDir(), "a.log")
	appendLines(t, path)
	c := &collect{err: ErrSessionClosed}
	_, done := start(t, fileSource(path), c)
	time.Sleep(60 * time.Millisecond)
	appendLines(t, path, "one")
	select {
	case err := <-done:
		if !errors.Is(err, ErrSessionClosed) {
			t.Errorf("err = %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("tail kept running after the session closed")
	}
}

// A quiet source still learns that the viewer left: an empty chunk goes out after Idle
// (Review Focus #3), so the host's tail slot is freed within seconds, not at the 15-minute TTL.
func TestStreamStopsOnAQuietSourceWhenTheSessionCloses(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quiet.log")
	appendLines(t, path)
	c := &collect{err: ErrSessionClosed}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	done := make(chan error, 1)
	go func() {
		done <- Stream(ctx, fileSource(path), c.send, Options{Flush: 50 * time.Millisecond, Poll: 20 * time.Millisecond, Idle: 200 * time.Millisecond})
	}()
	select {
	case err := <-done:
		if !errors.Is(err, ErrSessionClosed) {
			t.Errorf("err = %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("a quiet tail never noticed the session closed")
	}
}

func TestSourcesComeFromAppliedPacksOnly(t *testing.T) {
	ids := func(s []Source) []string {
		var out []string
		for _, x := range s {
			out = append(out, x.ID)
		}
		return out
	}
	none := ids(Sources(nil))
	if strings.Join(none, ",") != "host.journal" {
		t.Errorf("no packs: %v", none)
	}
	got := ids(Sources([]collector.PackConfig{{ID: "redis"}, {ID: "nginx"}, {ID: "nodejs"}}))
	if strings.Join(got, ",") != "redis.server,nginx.access,nginx.error,nodejs.journal,host.journal" {
		t.Errorf("sources = %v", got)
	}
	if _, ok := Find(Sources([]collector.PackConfig{{ID: "redis"}}), "nginx.access"); ok {
		t.Error("a source of a pack that is not applied was allowed")
	}
	for _, bad := range []string{"/etc/shadow", "../etc/passwd", "redis.server/../x", ""} {
		if _, ok := Find(Sources([]collector.PackConfig{{ID: "redis"}}), bad); ok {
			t.Errorf("Find(%q) allowed", bad)
		}
	}
}

func TestJournalCommandHasNoShell(t *testing.T) {
	src, _ := Find(Sources([]collector.PackConfig{{ID: "nodejs"}}), "nodejs.journal")
	args := journalArgs(src)
	if strings.Join(args, " ") != "-f -n 0 -o cat _COMM=node" {
		t.Errorf("args = %v", args)
	}
	host, _ := Find(Sources(nil), "host.journal")
	if strings.Join(journalArgs(host), " ") != "-f -n 0 -o cat" {
		t.Errorf("host args = %v", journalArgs(host))
	}
}

func TestResolvePicksTheFirstExistingPath(t *testing.T) {
	dir := t.TempDir()
	appendLines(t, filepath.Join(dir, "postgresql-16-main.log"), "x")
	src := Source{ID: "postgresql.main", Kind: KindFile, Paths: []string{filepath.Join(dir, "missing.log"), filepath.Join(dir, "postgresql-*-main.log")}}
	if p, ok := Resolve(src); !ok || !strings.HasSuffix(p, "postgresql-16-main.log") {
		t.Errorf("Resolve = %q %v", p, ok)
	}
}
