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
			case <-ctx.Done():
				_ = cmd.Process.Signal(syscall.SIGTERM)
				select {
				case <-done:
				case <-time.After(10 * time.Second):
					_ = cmd.Process.Kill()
					<-done
				}
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

// SleepContext waits for d or until ctx is cancelled.
func SleepContext(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}
