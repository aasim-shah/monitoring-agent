// Command pcp-helper is the opt-in root helper for allowlisted operational actions (D20,
// WB-16 UC-16-08). It listens on a unix socket that only the pcp-agent group can reach, accepts
// only Ed25519-signed, unexpired, single-use tasks, and restarts only systemd units the host
// owner listed in /etc/pcp-agent/helper.yaml. It never runs a shell.
package main

import (
	"bufio"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"os/user"
	"strconv"
	"strings"
	"syscall"
	"time"
)

var version = "0.3.0"

const maxRequestBytes = 64 * 1024

func main() {
	socket := flag.String("socket", "/run/pcp-helper/helper.sock", "unix socket path")
	keyPath := flag.String("key", "/etc/pcp-agent/task-signing.pub", "root-owned platform task-signing public key (base64)")
	allowlist := flag.String("allowlist", "/etc/pcp-agent/helper.yaml", "customer-owned allowlist")
	state := flag.String("state", "/var/lib/pcp-helper", "state directory (used task IDs)")
	group := flag.String("group", "pcp-agent", "group allowed to use the socket")
	flag.Parse()

	key, err := readKey(*keyPath)
	if err != nil {
		log.Fatalf("pcp-helper: %v", err)
	}
	g, err := user.LookupGroup(*group)
	if err != nil {
		log.Fatalf("pcp-helper: group %s: %v", *group, err)
	}
	gid, _ := strconv.Atoi(g.Gid)
	ln, err := listen(*socket, gid)
	if err != nil {
		log.Fatalf("pcp-helper: %v", err)
	}
	h := &Helper{
		Key:           key,
		AllowlistPath: *allowlist,
		Used:          &UsedTasks{Path: *state + "/used-tasks"},
		Systemd:       systemctl{},
		Now:           time.Now,
		Wait:          60 * time.Second,
		Settle:        3 * time.Second,
		Sleep:         time.Sleep,
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	go func() {
		<-ctx.Done()
		ln.Close()
	}()
	log.Printf("pcp-helper %s listening on %s", version, *socket)
	serve(ln, h)
}

func readKey(path string) (ed25519.PublicKey, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("task key: %w (re-run the installer with --enable-helper)", err)
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(data)))
	if err != nil || len(raw) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("task key %s is not a base64 Ed25519 public key", path)
	}
	return ed25519.PublicKey(raw), nil
}

// listen creates the socket with mode 0660 and the given group: root and the agent only.
func listen(path string, gid int) (net.Listener, error) {
	_ = os.Remove(path)
	ln, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(path, 0o660); err != nil {
		ln.Close()
		return nil, err
	}
	if err := os.Chown(path, -1, gid); err != nil {
		ln.Close()
		return nil, err
	}
	return ln, nil
}

// serve answers one task per connection, one at a time (actions on a host never overlap).
func serve(ln net.Listener, h *Helper) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		func() {
			defer conn.Close()
			_ = conn.SetDeadline(time.Now().Add(2 * time.Minute))
			line, err := bufio.NewReader(&limited{conn, maxRequestBytes}).ReadBytes('\n')
			res := failed("request too large or unreadable")
			if err == nil {
				res = h.Handle(line)
			}
			log.Printf("task → %s %s", res.Status, res.Error)
			_ = json.NewEncoder(conn).Encode(res)
		}()
	}
}

type limited struct {
	c net.Conn
	n int
}

func (l *limited) Read(p []byte) (int, error) {
	if l.n <= 0 {
		return 0, fmt.Errorf("request over %d bytes", maxRequestBytes)
	}
	if len(p) > l.n {
		p = p[:l.n]
	}
	n, err := l.c.Read(p)
	l.n -= n
	return n, err
}

// systemctl runs systemctl with an argv, never through a shell (BR-16-09).
type systemctl struct{}

func (systemctl) Restart(unit string) error {
	out, err := exec.Command("systemctl", "restart", "--", unit).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%v: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func (systemctl) ActiveState(unit string) (string, error) {
	// is-active exits non-zero for inactive units but still prints the state.
	out, _ := exec.Command("systemctl", "is-active", "--", unit).Output()
	return strings.TrimSpace(string(out)), nil
}
