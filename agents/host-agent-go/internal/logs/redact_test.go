package logs

import (
	"strings"
	"testing"
)

// The corpus from WB-12 UC-12-02: every secret is masked before a line leaves the host.
func TestRedactCorpus(t *testing.T) {
	cases := []struct{ in, want string }{
		{`GET /api Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig123`, `GET /api Authorization: [REDACTED]`},
		{`authorization=Basic dXNlcjpwYXNz`, `authorization=[REDACTED]`},
		{`token issued eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcDEF_123 for user`, `token issued [JWT] for user`},
		{`push with ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`, `push with [TOKEN]`},
		{`openai sk-proj-abcdefghijklmnopqrstuvwx`, `openai [TOKEN]`},
		// Built at runtime so secret scanners do not mistake the fixture for a real key.
		{"stripe " + "sk_" + "live_" + strings.Repeat("Xy7", 8), `stripe [TOKEN]`},
		{`slack xoxb-123456789012-abcdefghijkl`, `slack [TOKEN]`},
		{`aws AKIAIOSFODNN7EXAMPLE used`, `aws [TOKEN] used`},
		{`login password=hunter2 ok`, `login password=[REDACTED] ok`},
		{`config secret: s3cr3t-value`, `config secret: [REDACTED]`},
		{`{"api_key":"abc123","x":1}`, `{"api_key":"[REDACTED]","x":1}`},
		{`dsn postgres://app:pa55word@db:5432/app`, `dsn postgres://app:[REDACTED]@db:5432/app`},
		{`{"user":"jane.doe+test@example.co.uk","ok":true}`, `{"user":"[EMAIL]","ok":true}`},
		{`charge card 4111 1111 1111 1111 approved`, `charge card [CARD] approved`},
		{`charge card 5500-0000-0000-0004 approved`, `charge card [CARD] approved`},
	}
	for _, c := range cases {
		if got := Redact(c.in); got != c.want {
			t.Errorf("Redact(%q)\n got  %q\n want %q", c.in, got, c.want)
		}
	}
}

func TestRedactKeepsOrdinaryNumbersAndIsIdempotent(t *testing.T) {
	for _, keep := range []string{
		"order 1234567890123 shipped",       // 13 digits, not Luhn-valid
		"took 120ms, 4096 bytes, pid 31337", // short numbers
		"2026-10-23T10:00:00Z redis ready",  // timestamps
	} {
		if got := Redact(keep); got != keep {
			t.Errorf("Redact(%q) = %q, want unchanged", keep, got)
		}
	}
	once := Redact(`password=x Authorization: Bearer abc jane@example.com`)
	if twice := Redact(once); twice != once {
		t.Errorf("not idempotent: %q then %q", once, twice)
	}
}

func TestRedactTruncatesLongLines(t *testing.T) {
	got := Redact(strings.Repeat("a", 10_000))
	if len(got) > MaxLineBytes+len(truncatedMarker) || !strings.HasSuffix(got, truncatedMarker) {
		t.Errorf("len %d, suffix %q", len(got), got[len(got)-20:])
	}
}
