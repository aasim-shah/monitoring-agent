package logs

import (
	"context"
	"errors"
	"fmt"

	"pcp.local/hostagent/internal/collector"
)

// RunTask executes a `log_tail` task: the source must be one this host allows for its
// applied packs (never a path from the request). Lines are posted as numbered chunks; a
// final chunk closes the stream when the tail ends (TTL, cancel, or the viewer closing).
func RunTask(
	ctx context.Context,
	payload map[string]any,
	applied []collector.PackConfig,
	post func(sequence int64, lines []string, final bool) error,
	opts Options,
) (map[string]any, error) {
	id, _ := payload["source"].(string)
	src, ok := Find(Sources(applied), id)
	if !ok {
		return nil, fmt.Errorf("log source %q is not allowed on this host", id)
	}
	var seq int64
	sent := 0
	err := Stream(ctx, src, func(lines []string) error {
		if err := post(seq, lines, false); err != nil {
			return err
		}
		seq++
		sent += len(lines)
		return nil
	}, opts)
	if errors.Is(err, ErrSessionClosed) {
		return map[string]any{"lines": sent, "ended": "viewer closed"}, nil
	}
	if err != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
		_ = post(seq, []string{fmt.Sprintf("[pcp] stream stopped: %v", err)}, true)
		return nil, err
	}
	_ = post(seq, []string{}, true)
	return map[string]any{"lines": sent, "ended": "time limit"}, nil
}
