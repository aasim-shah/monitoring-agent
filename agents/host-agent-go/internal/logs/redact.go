// Package logs tails service logs on the host for the live viewer (WB-12): sources come
// from the applied packs only, and every line is redacted before it leaves the host.
package logs

import (
	"regexp"
	"strings"
	"unicode/utf8"

	"pcp.local/hostagent/internal/redact"
)

// MaxLineBytes caps a line sent to the control plane (master plan §3).
const MaxLineBytes = 4096

const truncatedMarker = " …[truncated]"

var (
	rules    = compile()
	cardLike = regexp.MustCompile(redact.CardLike)
)

func compile() []*regexp.Regexp {
	out := make([]*regexp.Regexp, len(redact.Rules))
	for i, r := range redact.Rules {
		out[i] = regexp.MustCompile(r.Pattern)
	}
	return out
}

// Redact masks credentials and personal data in one log line (UC-12-02) and caps its size.
// Applying it twice changes nothing more.
func Redact(line string) string {
	if len(line) > MaxLineBytes {
		cut := MaxLineBytes
		for cut > 0 && !utf8.RuneStart(line[cut]) {
			cut--
		}
		line = line[:cut] + truncatedMarker
	}
	for i, re := range rules {
		line = re.ReplaceAllString(line, redact.Rules[i].Replacement)
	}
	line = cardLike.ReplaceAllStringFunc(line, func(m string) string {
		digits := strings.NewReplacer(" ", "", "-", "").Replace(m)
		if len(digits) >= 13 && len(digits) <= 19 && luhn(digits) {
			return "[CARD]"
		}
		return m
	})
	return line
}

func luhn(digits string) bool {
	sum := 0
	double := false
	for i := len(digits) - 1; i >= 0; i-- {
		d := int(digits[i] - '0')
		if double {
			d *= 2
			if d > 9 {
				d -= 9
			}
		}
		sum += d
		double = !double
	}
	return sum%10 == 0
}
