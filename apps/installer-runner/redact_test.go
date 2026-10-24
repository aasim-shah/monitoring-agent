package main

import (
	"strings"
	"testing"
)

// Review Focus #1 and #5: the token and the password never leave the runner.
func TestOutputRedactsSecretsAndCaps(t *testing.T) {
	o := newOutput("pcp_enr_secret", "hunter2", "")
	_, _ = o.Write([]byte("enrolling with pcp_enr_secret\n[sudo] password: hunter2\n"))
	got := o.String()
	if strings.Contains(got, "pcp_enr_secret") || strings.Contains(got, "hunter2") {
		t.Fatalf("secret in output: %q", got)
	}
	if !strings.Contains(got, "enrolling with [redacted]") {
		t.Errorf("output = %q", got)
	}
	_, _ = o.Write([]byte(strings.Repeat("x", MaxOutput)))
	if got := o.String(); !strings.HasSuffix(got, "[output truncated at 64 KB]\n") || len(got) > MaxOutput+64 {
		t.Errorf("not capped: %d bytes", len(got))
	}
}
