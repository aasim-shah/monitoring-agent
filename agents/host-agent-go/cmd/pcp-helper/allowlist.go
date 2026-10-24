package main

import (
	"bufio"
	"bytes"
	"strings"
)

// parseAllowlist reads the units under capabilities.service_restart.units from the
// customer-owned /etc/pcp-agent/helper.yaml. It understands the two YAML list forms the
// documentation shows (flow `[a, b]` and block `- a`) and comments; anything else lists nothing.
func parseAllowlist(data []byte) ([]string, error) {
	var units []string
	inRestart, inUnits := false, false
	restartIndent, unitsIndent := -1, -1
	sc := bufio.NewScanner(bytes.NewReader(data))
	for sc.Scan() {
		line := sc.Text()
		if i := strings.Index(line, "#"); i >= 0 {
			line = line[:i]
		}
		if strings.TrimSpace(line) == "" {
			continue
		}
		indent := len(line) - len(strings.TrimLeft(line, " "))
		text := strings.TrimSpace(line)
		if inUnits && indent > unitsIndent && strings.HasPrefix(text, "- ") {
			units = append(units, unquote(strings.TrimSpace(text[2:])))
			continue
		}
		inUnits = false
		if inRestart && indent <= restartIndent {
			inRestart = false
		}
		switch {
		case text == "service_restart:":
			inRestart, restartIndent = true, indent
		case inRestart && strings.HasPrefix(text, "units:"):
			rest := strings.TrimSpace(strings.TrimPrefix(text, "units:"))
			if rest == "" {
				inUnits, unitsIndent = true, indent
				continue
			}
			rest = strings.TrimSuffix(strings.TrimPrefix(rest, "["), "]")
			for _, u := range strings.Split(rest, ",") {
				if u = unquote(strings.TrimSpace(u)); u != "" {
					units = append(units, u)
				}
			}
		}
	}
	return units, sc.Err()
}

func unquote(s string) string {
	return strings.Trim(s, `"'`)
}

// packInstallEnabled reads capabilities.pack_install.enabled from helper.yaml; anything but
// `enabled: true` under pack_install is off (BR-05-08).
func packInstallEnabled(data []byte) bool {
	inPack := false
	packIndent := -1
	sc := bufio.NewScanner(bytes.NewReader(data))
	for sc.Scan() {
		line := sc.Text()
		if i := strings.Index(line, "#"); i >= 0 {
			line = line[:i]
		}
		if strings.TrimSpace(line) == "" {
			continue
		}
		indent := len(line) - len(strings.TrimLeft(line, " "))
		text := strings.TrimSpace(line)
		if inPack && indent <= packIndent {
			inPack = false
		}
		switch {
		case text == "pack_install:":
			inPack, packIndent = true, indent
		case inPack && strings.HasPrefix(text, "enabled:"):
			return strings.TrimSpace(strings.TrimPrefix(text, "enabled:")) == "true"
		}
	}
	return false
}
