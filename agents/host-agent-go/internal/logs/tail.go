package logs

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
	"time"
)

// ErrSessionClosed is returned by the sender when the viewer went away (the control plane answers 404).
var ErrSessionClosed = errors.New("log stream session closed")

// Options bound a stream (master plan §3: 200 lines/s).
type Options struct {
	Rate  int           // lines per second
	Flush time.Duration // how often a chunk is sent
	Poll  time.Duration // file polling interval
	// Idle is how long a quiet stream waits before sending an empty chunk, so it learns
	// within seconds that the viewer left (the control plane answers 404).
	Idle time.Duration
}

func (o Options) withDefaults() Options {
	if o.Rate <= 0 {
		o.Rate = 200
	}
	if o.Flush <= 0 {
		o.Flush = 500 * time.Millisecond
	}
	if o.Poll <= 0 {
		o.Poll = 250 * time.Millisecond
	}
	if o.Idle <= 0 {
		o.Idle = 5 * time.Second
	}
	return o
}

type buffer struct {
	mu      sync.Mutex
	lines   []string
	max     int
	dropped int
}

func (b *buffer) add(line string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.lines) >= b.max {
		b.dropped++
		return
	}
	b.lines = append(b.lines, Redact(line))
}

func (b *buffer) take(n int) ([]string, int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if n > len(b.lines) {
		n = len(b.lines)
	}
	out := append([]string(nil), b.lines[:n]...)
	b.lines = b.lines[n:]
	d := b.dropped
	b.dropped = 0
	return out, d
}

// Stream follows a source from its current end and sends redacted lines in chunks, at most
// Rate lines per second; excess lines are dropped and reported. It returns when ctx ends,
// the source fails, or send fails (ErrSessionClosed when the viewer closed).
func Stream(ctx context.Context, src Source, send func([]string) error, opts Options) error {
	opts = opts.withDefaults()
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	buf := &buffer{max: opts.Rate * 2}
	readErr := make(chan error, 1)
	go func() {
		switch src.Kind {
		case KindJournal:
			readErr <- followJournal(ctx, src, buf.add)
		default:
			path, ok := Resolve(src)
			if !ok {
				readErr <- fmt.Errorf("no log file found for %s", src.ID)
				return
			}
			readErr <- followFile(ctx, path, opts.Poll, buf.add)
		}
	}()
	perFlush := max(1, int(float64(opts.Rate)*opts.Flush.Seconds()))
	ticker := time.NewTicker(opts.Flush)
	defer ticker.Stop()
	lastSend := time.Now()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case err := <-readErr:
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return err
		case <-ticker.C:
			lines, dropped := buf.take(perFlush)
			if dropped > 0 {
				lines = append(lines, fmt.Sprintf("[pcp] dropped %d lines (rate limit %d/s)", dropped, opts.Rate))
			}
			if len(lines) == 0 && time.Since(lastSend) < opts.Idle {
				continue
			}
			if err := send(lines); err != nil {
				return err
			}
			lastSend = time.Now()
		}
	}
}

// followFile reads appended lines, starting at the end; it reopens the path after rotation
// (a new file at the path) and starts over after truncation.
func followFile(ctx context.Context, path string, poll time.Duration, emit func(string)) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer func() { f.Close() }()
	offset, err := f.Seek(0, io.SeekEnd)
	if err != nil {
		return err
	}
	opened, _ := f.Stat()
	reader := bufio.NewReader(f)
	partial := ""
	ticker := time.NewTicker(poll)
	defer ticker.Stop()
	for {
		for {
			chunk, err := reader.ReadString('\n')
			offset += int64(len(chunk))
			if err != nil {
				partial += chunk
				break
			}
			emit(trimNewline(partial + chunk))
			partial = ""
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
		current, err := os.Stat(path)
		switch {
		case err != nil:
			// Rotated away and not recreated yet: keep reading the old handle.
		case !os.SameFile(opened, current):
			nf, err := os.Open(path)
			if err != nil {
				continue
			}
			f.Close()
			f, opened, offset, partial = nf, current, 0, ""
			reader = bufio.NewReader(f)
		case current.Size() < offset:
			if _, err := f.Seek(0, io.SeekStart); err == nil {
				offset, partial = 0, ""
				reader.Reset(f)
			}
		}
	}
}

func followJournal(ctx context.Context, src Source, emit func(string)) error {
	cmd := exec.CommandContext(ctx, "journalctl", journalArgs(src)...)
	out, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	scanner := bufio.NewScanner(out)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		emit(scanner.Text())
	}
	_ = cmd.Wait()
	if ctx.Err() != nil {
		return nil
	}
	return errors.New("journalctl exited")
}

func trimNewline(s string) string {
	for len(s) > 0 && (s[len(s)-1] == '\n' || s[len(s)-1] == '\r') {
		s = s[:len(s)-1]
	}
	return s
}
