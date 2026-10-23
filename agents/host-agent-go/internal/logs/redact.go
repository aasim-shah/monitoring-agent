// Package logs tails service logs on the host for the live viewer (WB-12): sources come
// from the applied packs only, and every line is redacted before it leaves the host.
package logs

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

// MaxLineBytes caps a line sent to the control plane (master plan §3).
const MaxLineBytes = 4096

const truncatedMarker = " …[truncated]"

var (
	authHeader = regexp.MustCompile(`(?i)(authorization["']?\s*[:=]\s*)("?)(?:(?:bearer|basic|token|digest)\s+)?[^\s,;"']+`)
	urlCreds   = regexp.MustCompile(`(?i)(\b[a-z][a-z0-9+.-]*://[^:/\s@]+:)[^@\s/]+@`)
	jwt        = regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+`)
	tokens     = regexp.MustCompile(`\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|[sr]k_(?:live|test)_[A-Za-z0-9]{10,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|pcp_enr_[A-Za-z0-9_-]{20,})`)
	keyValue   = regexp.MustCompile(`(?i)(\b(?:password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token|token)\b["']?\s*[:=]\s*["']?)([^\s"',;&]+)`)
	email      = regexp.MustCompile(`[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}`)
	cardLike   = regexp.MustCompile(`\b(?:\d[ -]?){12,18}\d\b`)
)

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
	line = authHeader.ReplaceAllString(line, "${1}${2}[REDACTED]")
	line = urlCreds.ReplaceAllString(line, "${1}[REDACTED]@")
	line = jwt.ReplaceAllString(line, "[JWT]")
	line = tokens.ReplaceAllString(line, "[TOKEN]")
	line = keyValue.ReplaceAllString(line, "${1}[REDACTED]")
	line = email.ReplaceAllString(line, "[EMAIL]")
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
