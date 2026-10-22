package discovery

import (
	"bufio"
	"encoding/hex"
	"io/fs"
	"net"
	"strconv"
	"strings"
)

const maxListeners = 500

type listener struct {
	Address string
	Port    int64
}

// readListeners returns the TCP sockets in LISTEN state (st 0A) from net/tcp and
// net/tcp6, deduplicated, at most maxListeners. Missing files and bad lines are skipped.
func readListeners(fsys fs.FS) []listener {
	seen := map[listener]bool{}
	var out []listener
	for _, name := range []string{"net/tcp", "net/tcp6"} {
		f, err := fsys.Open(name)
		if err != nil {
			continue
		}
		sc := bufio.NewScanner(f)
		for sc.Scan() && len(out) < maxListeners {
			l, ok := parseTCPLine(sc.Text())
			if !ok || seen[l] {
				continue
			}
			seen[l] = true
			out = append(out, l)
		}
		f.Close()
	}
	return out
}

func parseTCPLine(line string) (listener, bool) {
	fields := strings.Fields(line)
	if len(fields) < 4 || fields[3] != "0A" {
		return listener{}, false
	}
	hostHex, portHex, ok := strings.Cut(fields[1], ":")
	if !ok {
		return listener{}, false
	}
	port, err := strconv.ParseUint(portHex, 16, 16)
	if err != nil {
		return listener{}, false
	}
	ip, ok := parseProcIP(hostHex)
	if !ok {
		return listener{}, false
	}
	return listener{Address: ip.String(), Port: int64(port)}, true
}

// parseProcIP decodes the kernel's hex address: 32-bit words in host (little-endian) order.
func parseProcIP(s string) (net.IP, bool) {
	raw, err := hex.DecodeString(s)
	if err != nil || (len(raw) != 4 && len(raw) != 16) {
		return nil, false
	}
	ip := make(net.IP, len(raw))
	for w := 0; w < len(raw); w += 4 {
		for i := 0; i < 4; i++ {
			ip[w+i] = raw[w+3-i]
		}
	}
	return ip, true
}
