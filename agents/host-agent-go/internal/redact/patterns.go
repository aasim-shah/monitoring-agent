// Package redact holds the masking rules applied on the host before any log line leaves it
// (UC-12-02, BR-12-04): the live tail applies them in Go, retained logs in the collector (OTTL).
package redact

// Rule is one regular expression (RE2 syntax, shared by Go and OTTL) and its replacement
// (`${n}` refers to a capture group).
type Rule struct {
	Pattern     string
	Replacement string
}

// Rules, in the order they are applied.
var Rules = []Rule{
	{`(?i)(authorization["']?\s*[:=]\s*)("?)(?:(?:bearer|basic|token|digest)\s+)?[^\s,;"']+`, "${1}${2}[REDACTED]"},
	{`(?i)(\b[a-z][a-z0-9+.-]*://[^:/\s@]+:)[^@\s/]+@`, "${1}[REDACTED]@"},
	{`\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+`, "[JWT]"},
	{`\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|[sr]k_(?:live|test)_[A-Za-z0-9]{10,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|pcp_enr_[A-Za-z0-9_-]{20,})`, "[TOKEN]"},
	{`(?i)(\b(?:password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token|token)\b["']?\s*[:=]\s*["']?)([^\s"',;&]+)`, "${1}[REDACTED]"},
	{`[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}`, "[EMAIL]"},
}

// CardLike finds digit runs that may be card numbers; the live tail masks those that pass a Luhn
// check, retained logs mask every 13–19 digit run (OTTL has no Luhn check).
const CardLike = `\b(?:\d[ -]?){12,18}\d\b`
