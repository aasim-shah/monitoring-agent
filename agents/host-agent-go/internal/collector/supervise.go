package collector

import (
	"context"
	"os/exec"
	"syscall"
	"time"
)

// Supervisor keeps the collector running, restarting it with exponential backoff
// (1 s doubling to 60 s; reset after 5 minutes of healthy running).
type Supervisor struct {
	Command func() *exec.Cmd
	Sleep   func(context.Context, time.Duration)
	Logf    func(format string, args ...any)
	// Restart, when signalled, stops the collector and starts it again at once
	// (a new configuration was written).
	Restart <-chan struct{}
}

const healthyAfter = 5 * time.Minute

func backoff(failures int) time.Duration {
	d := time.Second << min(failures, 6)
	return min(d, 60*time.Second)
}

// Run blocks until ctx is cancelled, then stops the collector (SIGTERM, then SIGKILL after 10 s).
func (s Supervisor) Run(ctx context.Context) {
	failures := 0
	for ctx.Err() == nil {
		cmd := s.Command()
		started := time.Now()
		if err := cmd.Start(); err != nil {
			s.Logf("collector failed to start: %v", err)
		} else {
			done := make(chan error, 1)
			go func() { done <- cmd.Wait() }()
			select {
			case err := <-done:
				s.Logf("collector exited: %v", err)
			case <-s.Restart:
				s.Logf("restarting the collector with a new configuration")
				stop(cmd, done)
				continue
			case <-ctx.Done():
				stop(cmd, done)
				return
			}
		}
		if time.Since(started) > healthyAfter {
			failures = 0
		}
		s.Sleep(ctx, backoff(failures))
		failures++
	}
}

// stop sends SIGTERM, then SIGKILL after 10 s, and waits for the process to exit.
func stop(cmd *exec.Cmd, done <-chan error) {
	_ = cmd.Process.Signal(syscall.SIGTERM)
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		_ = cmd.Process.Kill()
		<-done
	}
}

// SleepContext waits for d or until ctx is cancelled.
func SleepContext(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}
