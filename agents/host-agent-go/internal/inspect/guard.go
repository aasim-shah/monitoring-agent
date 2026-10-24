// Package inspect reads statistics about a customer's Redis and Kafka (WB-12 UC-12-06/07): a fixed,
// read-only command set, never data values, and only for keys and topics the owner allowlisted.
package inspect

import (
	"fmt"
	"regexp"
	"strings"
)

// redisAllowed maps each allowed command to the subcommand it must have ("" when none).
var redisAllowed = map[string]string{
	"AUTH":    "",
	"INFO":    "",
	"DBSIZE":  "",
	"SLOWLOG": "GET",
	"LATENCY": "LATEST",
	"CLIENT":  "LIST",
	"MEMORY":  "STATS|USAGE",
	"TYPE":    "",
	"LLEN":    "",
	"XLEN":    "",
	"SCARD":   "",
	"ZCARD":   "",
}

// allowedRedis refuses any command outside the read-only allowlist (TC-12-06): no MONITOR, no
// KEYS, no SCAN, no value reads, no writes, no scripts, no CONFIG.
func allowedRedis(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("empty command")
	}
	cmd := strings.ToUpper(args[0])
	sub, ok := redisAllowed[cmd]
	if !ok {
		return fmt.Errorf("redis command %s is not allowed", cmd)
	}
	if sub != "" {
		if len(args) < 2 || !contains(strings.Split(sub, "|"), strings.ToUpper(args[1])) {
			return fmt.Errorf("redis command %s %s is not allowed", cmd, strings.Join(args[1:], " "))
		}
	}
	return nil
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// plainName is an exact key or topic name: no glob characters, spaces, or control characters
// (Review Focus #1), so nothing ever turns into a pattern scan.
var plainName = regexp.MustCompile(`^[A-Za-z0-9._:/@-]{1,200}$`)

// ValidName reports whether s can be allowlisted as a key or topic.
func ValidName(s string) bool { return plainName.MatchString(s) }
