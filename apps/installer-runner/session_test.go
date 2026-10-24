package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

// fakeHost is an SSH server standing in for a customer server: it accepts the session key for
// pcp-install until cleanup ran, a password for "admin", and records every command.
type fakeHost struct {
	t        *testing.T
	addr     string
	mu       sync.Mutex
	hostKey  ssh.Signer
	allowed  ssh.PublicKey
	removed  bool
	commands []string
	stdin    []string
}

func newFakeHost(t *testing.T) *fakeHost {
	h := &fakeHost{t: t, hostKey: newSigner(t)}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	h.addr = ln.Addr().String()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go h.serve(c)
		}
	}()
	return h
}

func newSigner(t *testing.T) ssh.Signer {
	_, k, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	s, err := ssh.NewSignerFromKey(k)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func (h *fakeHost) serve(c net.Conn) {
	h.mu.Lock()
	cfg := &ssh.ServerConfig{
		PublicKeyCallback: func(m ssh.ConnMetadata, k ssh.PublicKey) (*ssh.Permissions, error) {
			h.mu.Lock()
			defer h.mu.Unlock()
			if m.User() == "pcp-install" && !h.removed && h.allowed != nil && string(k.Marshal()) == string(h.allowed.Marshal()) {
				return nil, nil
			}
			return nil, errors.New("denied")
		},
		PasswordCallback: func(m ssh.ConnMetadata, p []byte) (*ssh.Permissions, error) {
			if m.User() == "admin" && string(p) == "hunter2" {
				return nil, nil
			}
			return nil, errors.New("denied")
		},
	}
	cfg.AddHostKey(h.hostKey)
	h.mu.Unlock()
	conn, chans, reqs, err := ssh.NewServerConn(c, cfg)
	if err != nil {
		return
	}
	defer conn.Close()
	go ssh.DiscardRequests(reqs)
	for nc := range chans {
		ch, in, err := nc.Accept()
		if err != nil {
			continue
		}
		go func() {
			defer ch.Close()
			for req := range in {
				if req.Type != "exec" {
					_ = req.Reply(false, nil)
					continue
				}
				var p struct{ Command string }
				_ = ssh.Unmarshal(req.Payload, &p)
				_ = req.Reply(true, nil)
				// The client closes stdin after sending it (empty in key mode).
				b, _ := io.ReadAll(ch)
				stdin := string(b)
				h.mu.Lock()
				h.commands = append(h.commands, p.Command)
				h.stdin = append(h.stdin, stdin)
				if strings.Contains(p.Command, "userdel") {
					h.removed = true
				}
				h.mu.Unlock()
				// The installer echoes its arguments, so the token reaches the output.
				fmt.Fprintf(ch, "PCP_SCRIPT_SHA256=abc123\nran: %s\n", p.Command)
				_, _ = ch.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{0}))
				return
			}
		}()
	}
}

func (h *fakeHost) recorded() ([]string, []string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]string(nil), h.commands...), append([]string(nil), h.stdin...)
}

type reports struct {
	mu  sync.Mutex
	all []Update
	ch  chan Update
}

func newReports() *reports { return &reports{ch: make(chan Update, 100)} }

func (r *reports) report(_, _ string, u Update) {
	r.mu.Lock()
	r.all = append(r.all, u)
	r.mu.Unlock()
	r.ch <- u
}

func (r *reports) waitFor(t *testing.T, status string) Update {
	t.Helper()
	deadline := time.After(10 * time.Second)
	for {
		select {
		case u := <-r.ch:
			if u.Status == status {
				return u
			}
		case <-deadline:
			t.Fatalf("no %q update; got %+v", status, r.all)
		}
	}
}

// waitClosed waits until the manager dropped the session (it closes after the last host's report).
func waitClosed(t *testing.T, m *Manager, id string) {
	t.Helper()
	for i := 0; i < 200; i++ {
		if _, ok := m.session(id); !ok {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("session %s still open", id)
}

func hostSpec(h *fakeHost, user string) HostSpec {
	host, port, _ := net.SplitHostPort(h.addr)
	p, _ := strconv.Atoi(port)
	return HostSpec{ID: "h1", Host: host, Port: p, Username: user}
}

var params = InstallParams{
	Token:            "pcp_enr_secret",
	ControlURL:       "https://agent.example.com",
	DownloadURL:      "https://monitor.example.com/downloads",
	InstallScriptURL: "https://monitor.example.com/install.sh",
}

func newTestManager(r *reports) *Manager {
	m := NewManager(r.report)
	m.cleanupWait = 0
	return m
}

func startKeySession(t *testing.T, m *Manager, h *fakeHost) {
	t.Helper()
	pub, err := m.Create(CreateRequest{SessionID: "s1", OrganizationID: "o1", Mode: "key", Hosts: []HostSpec{hostSpec(h, "pcp-install")}, Install: params, ExpiresAt: time.Now().Add(time.Hour)})
	if err != nil {
		t.Fatal(err)
	}
	k, _, _, _, err := ssh.ParseAuthorizedKey([]byte(pub))
	if err != nil {
		t.Fatalf("public key %q: %v", pub, err)
	}
	h.mu.Lock()
	h.allowed = k
	h.mu.Unlock()
}

// TC-05-06 (BR-05-03): connecting shows the fingerprint and runs nothing; a wrong fingerprint is refused.
func TestInstallRefusedBeforeConfirmation(t *testing.T) {
	h, r := newFakeHost(t), newReports()
	m := newTestManager(r)
	startKeySession(t, m, h)
	if err := m.Confirm("s1", "h1", ssh.FingerprintSHA256(h.hostKey.PublicKey())); !errors.Is(err, ErrNotConnected) {
		t.Fatalf("confirm before connect: %v", err)
	}
	if err := m.Connect("s1", ""); err != nil {
		t.Fatal(err)
	}
	u := r.waitFor(t, "awaiting_confirmation")
	if u.Fingerprint == nil || *u.Fingerprint != ssh.FingerprintSHA256(h.hostKey.PublicKey()) {
		t.Fatalf("fingerprint = %v", u.Fingerprint)
	}
	if err := m.Confirm("s1", "h1", "SHA256:wrong"); !errors.Is(err, ErrFingerprintMismatch) {
		t.Fatalf("wrong fingerprint: %v", err)
	}
	time.Sleep(100 * time.Millisecond)
	if cmds, _ := h.recorded(); len(cmds) != 0 {
		t.Fatalf("ran before confirmation: %v", cmds)
	}
}

// UC-05-05, TC-05-07: install, then remove the temporary user; the key no longer works and is destroyed.
func TestKeyModeInstallsThenRemovesItsAccess(t *testing.T) {
	h, r := newFakeHost(t), newReports()
	m := newTestManager(r)
	startKeySession(t, m, h)
	key := m.sessions["s1"].key
	if err := m.Connect("s1", ""); err != nil {
		t.Fatal(err)
	}
	fp := *r.waitFor(t, "awaiting_confirmation").Fingerprint
	if err := m.Confirm("s1", "h1", fp); err != nil {
		t.Fatal(err)
	}
	done := r.waitFor(t, "installed")
	if done.ScriptVersion == nil || *done.ScriptVersion != "abc123" {
		t.Errorf("script version = %v", done.ScriptVersion)
	}
	if done.Cleanup == nil || *done.Cleanup != "done" {
		t.Errorf("cleanup = %v (%v)", done.Cleanup, done.Error)
	}
	if done.Output == nil || strings.Contains(*done.Output, params.Token) || !strings.Contains(*done.Output, "--token '[redacted]'") {
		t.Errorf("output = %v", done.Output)
	}
	waitClosed(t, m, "s1")
	cmds, _ := h.recorded()
	if len(cmds) != 2 || !strings.Contains(cmds[0], "curl -fsSL 'https://monitor.example.com/install.sh'") || !strings.Contains(cmds[1], "userdel -r pcp-install") {
		t.Fatalf("commands = %q", cmds)
	}
	for _, b := range key {
		if b != 0 {
			t.Fatal("session key not destroyed")
		}
	}
}

// BR-05-03: a host key that changes between confirmation and install aborts the host.
func TestHostKeyChangeAborts(t *testing.T) {
	h, r := newFakeHost(t), newReports()
	m := newTestManager(r)
	startKeySession(t, m, h)
	_ = m.Connect("s1", "")
	fp := *r.waitFor(t, "awaiting_confirmation").Fingerprint
	h.mu.Lock()
	h.hostKey = newSigner(t)
	h.mu.Unlock()
	if err := m.Confirm("s1", "h1", fp); err != nil {
		t.Fatal(err)
	}
	u := r.waitFor(t, "failed")
	if u.Error == nil || !strings.Contains(*u.Error, "host key changed") {
		t.Errorf("error = %v", u.Error)
	}
	if cmds, _ := h.recorded(); len(cmds) != 0 {
		t.Fatalf("ran with a changed host key: %v", cmds)
	}
}

// UC-05-06, TC-05-09: the password goes only to sudo's stdin and never into output or reports.
func TestPasswordModeKeepsThePasswordOutOfEverything(t *testing.T) {
	h, r := newFakeHost(t), newReports()
	m := newTestManager(r)
	if _, err := m.Create(CreateRequest{SessionID: "s1", OrganizationID: "o1", Mode: "password", Hosts: []HostSpec{hostSpec(h, "admin")}, Install: params, ExpiresAt: time.Now().Add(time.Hour)}); err != nil {
		t.Fatal(err)
	}
	if err := m.Connect("s1", "hunter2"); err != nil {
		t.Fatal(err)
	}
	fp := *r.waitFor(t, "awaiting_confirmation").Fingerprint
	pw := m.sessions["s1"].password
	if err := m.Confirm("s1", "h1", fp); err != nil {
		t.Fatal(err)
	}
	done := r.waitFor(t, "installed")
	if done.Cleanup == nil || *done.Cleanup != "not_needed" {
		t.Errorf("cleanup = %v", done.Cleanup)
	}
	waitClosed(t, m, "s1")
	cmds, stdin := h.recorded()
	if len(cmds) != 1 || strings.Contains(cmds[0], "hunter2") || stdin[0] != "hunter2\n" {
		t.Fatalf("commands = %q stdin = %q", cmds, stdin)
	}
	for _, u := range r.all {
		for _, s := range []*string{u.Output, u.Error, u.Fingerprint} {
			if s != nil && strings.Contains(*s, "hunter2") {
				t.Fatalf("password in report: %+v", u)
			}
		}
	}
	for _, b := range pw {
		if b != 0 {
			t.Fatal("password not wiped")
		}
	}
}

func TestSessionLimitsAndAbort(t *testing.T) {
	m := newTestManager(newReports())
	hosts := make([]HostSpec, 11)
	for i := range hosts {
		hosts[i] = HostSpec{ID: fmt.Sprint(i), Host: "10.0.0.1", Port: 22, Username: "pcp-install"}
	}
	if _, err := m.Create(CreateRequest{SessionID: "s1", Mode: "key", Hosts: hosts, Install: params, ExpiresAt: time.Now().Add(time.Hour)}); err == nil {
		t.Error("11 hosts accepted")
	}
	if _, err := m.Create(CreateRequest{SessionID: "s2", Mode: "key", Hosts: hosts[:1], Install: params, ExpiresAt: time.Now().Add(time.Hour)}); err != nil {
		t.Fatal(err)
	}
	key := m.sessions["s2"].key
	m.Abort("s2")
	for _, b := range key {
		if b != 0 {
			t.Fatal("aborted session key not destroyed")
		}
	}
	if err := m.Connect("s2", ""); !errors.Is(err, ErrNoSession) {
		t.Errorf("connect after abort: %v", err)
	}
	// Expired sessions are dropped by the sweeper.
	if _, err := m.Create(CreateRequest{SessionID: "s3", Mode: "key", Hosts: hosts[:1], Install: params, ExpiresAt: time.Now().Add(-time.Second)}); err != nil {
		t.Fatal(err)
	}
	m.Expire()
	if _, ok := m.session("s3"); ok {
		t.Error("expired session kept")
	}
}
