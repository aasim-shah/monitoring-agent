package main

import (
	"bytes"
	"strings"
	"sync"
)

// MaxOutput caps the install output kept per host (Review Focus #1).
const MaxOutput = 64 << 10

// output collects a command's combined output, capped, and redacts secrets before anyone reads it.
type output struct {
	mu      sync.Mutex
	buf     bytes.Buffer
	secrets []string
	cut     bool
}

func newOutput(secrets ...string) *output {
	o := &output{}
	for _, s := range secrets {
		if s != "" {
			o.secrets = append(o.secrets, s)
		}
	}
	return o
}

func (o *output) Write(p []byte) (int, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if room := MaxOutput - o.buf.Len(); room > 0 {
		if len(p) > room {
			o.buf.Write(p[:room])
			o.cut = true
		} else {
			o.buf.Write(p)
		}
	} else {
		o.cut = true
	}
	return len(p), nil
}

// String is the output so far with every secret replaced by [redacted].
func (o *output) String() string {
	o.mu.Lock()
	defer o.mu.Unlock()
	s := redact(o.buf.String(), o.secrets...)
	if o.cut {
		s += "\n[output truncated at 64 KB]\n"
	}
	return s
}

func redact(s string, secrets ...string) string {
	for _, secret := range secrets {
		if secret != "" {
			s = strings.ReplaceAll(s, secret, "[redacted]")
		}
	}
	return s
}
