package inspect

import (
	"bufio"
	"context"
	"fmt"
	"net"
	"strconv"
	"strings"
	"sync"
	"testing"
)

// TC-12-06: only the read-only allowlist leaves the agent.
func TestGuardRefusesEverythingOutsideTheAllowlist(t *testing.T) {
	for _, cmd := range [][]string{
		{"MONITOR"}, {"KEYS", "*"}, {"GET", "k"}, {"HGETALL", "h"}, {"EVAL", "return 1", "0"},
		{"CONFIG", "GET", "requirepass"}, {"FLUSHALL"}, {"SET", "a", "b"}, {"SCAN", "0"}, {"DEBUG", "OBJECT", "k"},
		{"SLOWLOG", "RESET"}, {"CLIENT", "KILL", "x"}, {"MEMORY", "PURGE"}, {"LRANGE", "q", "0", "-1"},
	} {
		if err := allowedRedis(cmd); err == nil {
			t.Errorf("%v allowed", cmd)
		}
	}
	for _, cmd := range [][]string{
		{"INFO"}, {"DBSIZE"}, {"SLOWLOG", "GET", "10"}, {"LATENCY", "LATEST"}, {"CLIENT", "LIST"}, {"MEMORY", "STATS"},
		{"TYPE", "q"}, {"LLEN", "q"}, {"XLEN", "s"}, {"SCARD", "s"}, {"ZCARD", "z"}, {"MEMORY", "USAGE", "q"}, {"AUTH", "pw"},
	} {
		if err := allowedRedis(cmd); err != nil {
			t.Errorf("%v refused: %v", cmd, err)
		}
	}
}

// fakeRedis answers a few commands the way Redis 7 does and records what it was sent.
type fakeRedis struct {
	addr string
	mu   sync.Mutex
	seen [][]string
}

func newFakeRedis(t *testing.T, password string) *fakeRedis {
	f := &fakeRedis{}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	f.addr = ln.Addr().String()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go f.serve(c, password)
		}
	}()
	return f
}

func bulk(s string) string { return "$" + strconv.Itoa(len(s)) + "\r\n" + s + "\r\n" }

func (f *fakeRedis) serve(c net.Conn, password string) {
	defer c.Close()
	r := bufio.NewReader(c)
	authed := password == ""
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return
		}
		n, _ := strconv.Atoi(strings.TrimSpace(line[1:]))
		args := make([]string, n)
		for i := range args {
			_, _ = r.ReadString('\n')
			a, _ := r.ReadString('\n')
			args[i] = strings.TrimSpace(a)
		}
		f.mu.Lock()
		f.seen = append(f.seen, args)
		f.mu.Unlock()
		cmd := strings.ToUpper(strings.Join(args, " "))
		var out string
		switch {
		case args[0] == "AUTH":
			if args[len(args)-1] == password {
				authed, out = true, "+OK\r\n"
			} else {
				out = "-WRONGPASS invalid username-password pair\r\n"
			}
		case !authed:
			out = "-NOAUTH Authentication required.\r\n"
		case cmd == "INFO":
			out = bulk("# Server\r\nredis_version:7.2.4\r\nuptime_in_seconds:3600\r\nconfig_file:/etc/redis/redis.conf\r\n# Clients\r\nconnected_clients:3\r\n# Memory\r\nused_memory:1048576\r\nmaxmemory:0\r\nmem_fragmentation_ratio:1.20\r\n# Stats\r\nkeyspace_hits:90\r\nkeyspace_misses:10\r\nevicted_keys:0\r\ninstantaneous_ops_per_sec:12\r\n# Replication\r\nrole:master\r\n")
		case cmd == "DBSIZE":
			out = ":42\r\n"
		case cmd == "SLOWLOG GET 10":
			// One entry: SET with a secret value; only the command name may leave the agent.
			out = "*1\r\n*6\r\n:7\r\n:1761300000\r\n:15000\r\n*3\r\n" + bulk("SET") + bulk("session:abc") + bulk("hunter2-secret-value") + bulk("10.0.0.5:4242") + bulk("") + ""
		case cmd == "LATENCY LATEST":
			out = "*1\r\n*4\r\n" + bulk("command") + ":1761300000\r\n:25\r\n:40\r\n"
		case cmd == "CLIENT LIST":
			out = bulk("id=1 addr=10.0.0.5:4242 name=api cmd=get\nid=2 addr=10.0.0.6:4243 name= cmd=client|list\n")
		case cmd == "MEMORY STATS":
			out = "*6\r\n" + bulk("peak.allocated") + ":2097152\r\n" + bulk("dataset.bytes") + ":524288\r\n" + bulk("keys.count") + ":42\r\n"
		case cmd == "TYPE JOBS":
			out = "+list\r\n"
		case cmd == "LLEN JOBS":
			out = ":17\r\n"
		case cmd == "MEMORY USAGE JOBS":
			out = ":2048\r\n"
		case cmd == "TYPE MISSING":
			out = "+none\r\n"
		default:
			out = "-ERR unexpected " + cmd + "\r\n"
		}
		_, _ = fmt.Fprint(c, out)
	}
}

func TestRedisStatsWithoutValues(t *testing.T) {
	f := newFakeRedis(t, "s3cret")
	got, err := Redis(context.Background(), f.addr, "s3cret", []string{"jobs", "missing"})
	if err != nil {
		t.Fatal(err)
	}
	if got.Info["redis_version"] != "7.2.4" || got.Info["connected_clients"] != "3" || got.Info["role"] != "master" {
		t.Errorf("info = %v", got.Info)
	}
	if _, ok := got.Info["config_file"]; ok {
		t.Error("config_file is not an allowlisted INFO field")
	}
	if got.DBSize != 42 || got.Clients != 2 {
		t.Errorf("dbsize %d clients %d", got.DBSize, got.Clients)
	}
	if len(got.Slowlog) != 1 || got.Slowlog[0].Command != "SET" || got.Slowlog[0].DurationMicros != 15000 {
		t.Errorf("slowlog = %+v", got.Slowlog)
	}
	if len(got.Latency) != 1 || got.Latency[0].Event != "command" || got.Latency[0].MaxMs != 40 {
		t.Errorf("latency = %+v", got.Latency)
	}
	if got.Memory["dataset.bytes"] != 524288 {
		t.Errorf("memory = %v", got.Memory)
	}
	if len(got.Keys) != 2 || got.Keys[0] != (KeyStat{Key: "jobs", Type: "list", Length: 17, MemoryBytes: 2048}) || got.Keys[1].Type != "none" {
		t.Errorf("keys = %+v", got.Keys)
	}
	out := fmt.Sprintf("%+v", got)
	for _, leak := range []string{"hunter2", "session:abc", "10.0.0.5", "api"} {
		if strings.Contains(out, leak) {
			t.Errorf("value %q left the agent: %s", leak, out)
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, args := range f.seen {
		if err := allowedRedis(args); err != nil {
			t.Errorf("sent %v", args)
		}
	}
}

func TestRedisRefusesKeysThatAreNotPlainNames(t *testing.T) {
	f := newFakeRedis(t, "")
	for _, k := range []string{"*", "user:*", "a b", "q?", "[ab]", ""} {
		if _, err := Redis(context.Background(), f.addr, "", []string{k}); err == nil {
			t.Errorf("key %q accepted", k)
		}
	}
}
