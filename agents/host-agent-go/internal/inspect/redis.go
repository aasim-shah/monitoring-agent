package inspect

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"time"
)

// infoFields are the INFO fields the dashboard shows; paths, hostnames, and the rest stay on the host.
var infoFields = map[string]bool{
	"redis_version": true, "uptime_in_seconds": true, "connected_clients": true, "blocked_clients": true,
	"used_memory": true, "used_memory_peak": true, "maxmemory": true, "maxmemory_policy": true,
	"mem_fragmentation_ratio": true, "keyspace_hits": true, "keyspace_misses": true, "evicted_keys": true,
	"expired_keys": true, "instantaneous_ops_per_sec": true, "total_commands_processed": true,
	"rejected_connections": true, "role": true, "connected_slaves": true, "master_link_status": true,
	"rdb_last_bgsave_status": true, "aof_enabled": true, "aof_last_bgrewrite_status": true,
}

type SlowEntry struct {
	ID             int64  `json:"id"`
	At             int64  `json:"at"`
	DurationMicros int64  `json:"durationMicros"`
	Command        string `json:"command"` // the command name only; arguments may hold data
}

type LatencyEvent struct {
	Event    string `json:"event"`
	LatestMs int64  `json:"latestMs"`
	MaxMs    int64  `json:"maxMs"`
}

type KeyStat struct {
	Key         string `json:"key"`
	Type        string `json:"type"`
	Length      int64  `json:"length"`
	MemoryBytes int64  `json:"memoryBytes"`
}

// RedisStats is what an inspection returns: counts and sizes, never values.
type RedisStats struct {
	Info    map[string]string `json:"info"`
	DBSize  int64             `json:"dbSize"`
	Clients int               `json:"clients"`
	Slowlog []SlowEntry       `json:"slowlog"`
	Latency []LatencyEvent    `json:"latency"`
	Memory  map[string]int64  `json:"memory"`
	Keys    []KeyStat         `json:"keys"`
}

var lengthCommand = map[string]string{"list": "LLEN", "stream": "XLEN", "set": "SCARD", "zset": "ZCARD"}

// Redis inspects one instance with the allowlisted commands; keys are the owner's exact key names.
func Redis(ctx context.Context, addr, password string, keys []string) (*RedisStats, error) {
	for _, k := range keys {
		if !ValidName(k) {
			return nil, fmt.Errorf("key %q is not an exact key name", k)
		}
	}
	c, err := dialRedis(ctx, addr)
	if err != nil {
		return nil, err
	}
	defer c.close()
	if password != "" {
		if _, err := c.do("AUTH", password); err != nil {
			return nil, errors.New("authentication failed")
		}
	}
	s := &RedisStats{Info: map[string]string{}, Memory: map[string]int64{}}
	info, err := c.do("INFO")
	if err != nil {
		return nil, err
	}
	for _, line := range strings.Split(asString(info), "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(line), ":")
		if ok && infoFields[k] {
			s.Info[k] = v
		}
	}
	if v, err := c.do("DBSIZE"); err == nil {
		s.DBSize = asInt(v)
	}
	if v, err := c.do("CLIENT", "LIST"); err == nil {
		// One line per client; only the count leaves the host (lines carry addresses and names).
		for _, line := range strings.Split(asString(v), "\n") {
			if strings.TrimSpace(line) != "" {
				s.Clients++
			}
		}
	}
	if v, err := c.do("SLOWLOG", "GET", "10"); err == nil {
		for _, e := range asArray(v) {
			f := asArray(e)
			if len(f) < 4 {
				continue
			}
			entry := SlowEntry{ID: asInt(f[0]), At: asInt(f[1]), DurationMicros: asInt(f[2])}
			if args := asArray(f[3]); len(args) > 0 {
				entry.Command = strings.ToUpper(asString(args[0]))
			}
			s.Slowlog = append(s.Slowlog, entry)
		}
	}
	if v, err := c.do("LATENCY", "LATEST"); err == nil {
		for _, e := range asArray(v) {
			f := asArray(e)
			if len(f) >= 4 {
				s.Latency = append(s.Latency, LatencyEvent{Event: asString(f[0]), LatestMs: asInt(f[2]), MaxMs: asInt(f[3])})
			}
		}
	}
	if v, err := c.do("MEMORY", "STATS"); err == nil {
		f := asArray(v)
		for i := 0; i+1 < len(f); i += 2 {
			if n, ok := f[i+1].(int64); ok {
				s.Memory[asString(f[i])] = n
			}
		}
	}
	for _, k := range keys {
		st := KeyStat{Key: k}
		t, err := c.do("TYPE", k)
		if err != nil {
			return nil, err
		}
		st.Type = asString(t)
		if cmd, ok := lengthCommand[st.Type]; ok {
			if v, err := c.do(cmd, k); err == nil {
				st.Length = asInt(v)
			}
		}
		if st.Type != "none" {
			if v, err := c.do("MEMORY", "USAGE", k); err == nil {
				st.MemoryBytes = asInt(v)
			}
		}
		s.Keys = append(s.Keys, st)
	}
	return s, nil
}

type redisConn struct {
	conn net.Conn
	r    *bufio.Reader
}

func dialRedis(ctx context.Context, addr string) (*redisConn, error) {
	d := net.Dialer{Timeout: 5 * time.Second}
	conn, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("cannot reach redis at %s: %w", addr, err)
	}
	_ = conn.SetDeadline(time.Now().Add(15 * time.Second))
	return &redisConn{conn: conn, r: bufio.NewReader(conn)}, nil
}

func (c *redisConn) close() { _ = c.conn.Close() }

// do sends one allowlisted command; anything else never reaches the socket.
func (c *redisConn) do(args ...string) (any, error) {
	if err := allowedRedis(args); err != nil {
		return nil, err
	}
	var b strings.Builder
	fmt.Fprintf(&b, "*%d\r\n", len(args))
	for _, a := range args {
		fmt.Fprintf(&b, "$%d\r\n%s\r\n", len(a), a)
	}
	if _, err := io.WriteString(c.conn, b.String()); err != nil {
		return nil, err
	}
	return c.read()
}

func (c *redisConn) read() (any, error) {
	line, err := c.r.ReadString('\n')
	if err != nil {
		return nil, err
	}
	line = strings.TrimRight(line, "\r\n")
	if line == "" {
		return nil, errors.New("empty reply")
	}
	switch line[0] {
	case '+':
		return line[1:], nil
	case '-':
		return nil, errors.New(line[1:])
	case ':':
		n, err := strconv.ParseInt(line[1:], 10, 64)
		return n, err
	case '$':
		n, err := strconv.Atoi(line[1:])
		if err != nil || n < 0 {
			return nil, err
		}
		if n > 8<<20 {
			return nil, errors.New("reply too large")
		}
		buf := make([]byte, n+2)
		if _, err := io.ReadFull(c.r, buf); err != nil {
			return nil, err
		}
		return string(buf[:n]), nil
	case '*':
		n, err := strconv.Atoi(line[1:])
		if err != nil || n < 0 {
			return nil, err
		}
		out := make([]any, 0, n)
		for i := 0; i < n; i++ {
			v, err := c.read()
			if err != nil {
				return nil, err
			}
			out = append(out, v)
		}
		return out, nil
	}
	return nil, fmt.Errorf("unexpected reply %q", line[:1])
}

func asString(v any) string {
	s, _ := v.(string)
	return s
}

func asInt(v any) int64 {
	switch n := v.(type) {
	case int64:
		return n
	case string:
		i, _ := strconv.ParseInt(n, 10, 64)
		return i
	}
	return 0
}

func asArray(v any) []any {
	a, _ := v.([]any)
	return a
}
