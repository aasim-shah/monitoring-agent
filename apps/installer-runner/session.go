package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

// MaxHosts is the most hosts one assisted-install session may target (WB-05 UC-05-05).
const MaxHosts = 10

var (
	ErrNoSession           = errors.New("no such session")
	ErrNoHost              = errors.New("no such host in this session")
	ErrNotConnected        = errors.New("connect to the host and show its fingerprint first")
	ErrFingerprintMismatch = errors.New("the fingerprint does not match the one the host presented")
)

// InstallParams are what the fixed install command needs; the token lives only in memory.
type InstallParams struct {
	Token            string `json:"token"`
	ControlURL       string `json:"controlUrl"`
	DownloadURL      string `json:"downloadUrl"`
	InstallScriptURL string `json:"installScriptUrl"`
}

type HostSpec struct {
	ID       string `json:"id"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Username string `json:"username"`
}

type CreateRequest struct {
	SessionID      string        `json:"sessionId"`
	OrganizationID string        `json:"organizationId"`
	Mode           string        `json:"mode"` // key | password
	Hosts          []HostSpec    `json:"hosts"`
	Install        InstallParams `json:"install"`
	ExpiresAt      time.Time     `json:"expiresAt"`
}

// Update is what the runner reports about one host; the API stores it (no credential in it).
type Update struct {
	OrganizationID string  `json:"organizationId"`
	Status         string  `json:"status"`
	Fingerprint    *string `json:"fingerprint,omitempty"`
	Output         *string `json:"output,omitempty"`
	ScriptVersion  *string `json:"scriptVersion,omitempty"`
	Cleanup        *string `json:"cleanup,omitempty"`
	Error          *string `json:"error,omitempty"`
}

type Reporter func(sessionID, hostID string, u Update)

type hostState struct {
	spec        HostSpec
	fingerprint string
	confirmed   bool
	done        bool
}

// Session holds one install session's secrets in memory only (BR-05-01).
type Session struct {
	mu       sync.Mutex
	id, org  string
	mode     string
	key      ed25519.PrivateKey
	signer   ssh.Signer
	password []byte
	install  InstallParams
	hosts    map[string]*hostState
	expires  time.Time
}

// close destroys the session's private key and password.
func (s *Session) close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	clear(s.key)
	clear(s.password)
	s.install.Token = ""
}

type Manager struct {
	mu          sync.Mutex
	sessions    map[string]*Session
	report      Reporter
	cleanupWait time.Duration
	dialTimeout time.Duration
}

func NewManager(report Reporter) *Manager {
	return &Manager{sessions: map[string]*Session{}, report: report, cleanupWait: 5 * time.Second, dialTimeout: 15 * time.Second}
}

func (m *Manager) session(id string) (*Session, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[id]
	return s, ok
}

// Create starts a session. In key mode it returns the one-time public key in authorized_keys form.
func (m *Manager) Create(req CreateRequest) (string, error) {
	if len(req.Hosts) == 0 || len(req.Hosts) > MaxHosts {
		return "", fmt.Errorf("a session targets 1 to %d hosts", MaxHosts)
	}
	if req.Mode != "key" && req.Mode != "password" {
		return "", errors.New("mode must be key or password")
	}
	s := &Session{id: req.SessionID, org: req.OrganizationID, mode: req.Mode, install: req.Install, hosts: map[string]*hostState{}, expires: req.ExpiresAt}
	for _, h := range req.Hosts {
		s.hosts[h.ID] = &hostState{spec: h}
	}
	pub := ""
	if req.Mode == "key" {
		pk, k, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			return "", err
		}
		signer, err := ssh.NewSignerFromKey(k)
		if err != nil {
			return "", err
		}
		sshPub, err := ssh.NewPublicKey(pk)
		if err != nil {
			return "", err
		}
		s.key, s.signer = k, signer
		pub = strings.TrimSpace(string(ssh.MarshalAuthorizedKey(sshPub))) + " pcp-install-" + req.SessionID
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if old, ok := m.sessions[req.SessionID]; ok {
		old.close()
	}
	m.sessions[req.SessionID] = s
	return pub, nil
}

// Connect reads each host's key and checks that the runner can log in; nothing runs yet.
func (m *Manager) Connect(sessionID, password string) error {
	s, ok := m.session(sessionID)
	if !ok {
		return ErrNoSession
	}
	s.mu.Lock()
	if s.mode == "password" {
		if password == "" {
			s.mu.Unlock()
			return errors.New("password required")
		}
		clear(s.password)
		s.password = []byte(password)
	}
	hosts := make([]*hostState, 0, len(s.hosts))
	for _, h := range s.hosts {
		if !h.done && !h.confirmed {
			hosts = append(hosts, h)
		}
	}
	s.mu.Unlock()
	for _, h := range hosts {
		go m.connect(s, h)
	}
	return nil
}

func (m *Manager) connect(s *Session, h *hostState) {
	m.send(s, h, Update{Status: "connecting"})
	var seen string
	c, err := m.dial(s, h.spec, func(k ssh.PublicKey) error {
		seen = ssh.FingerprintSHA256(k)
		return nil
	})
	if seen == "" {
		m.fail(s, h, fmt.Sprintf("cannot reach %s:%d: %v", h.spec.Host, h.spec.Port, err))
		return
	}
	if err != nil {
		hint := "add the session's public key to the pcp-install user"
		if s.mode == "password" {
			hint = "check the user name and password"
		}
		m.send(s, h, Update{Status: "failed", Fingerprint: &seen, Error: str("login failed (" + hint + ")")})
		return
	}
	_ = c.Close()
	s.mu.Lock()
	h.fingerprint = seen
	s.mu.Unlock()
	m.send(s, h, Update{Status: "awaiting_confirmation", Fingerprint: &seen})
}

// Confirm records the admin's confirmation of a host's fingerprint and starts the install.
func (m *Manager) Confirm(sessionID, hostID, fingerprint string) error {
	s, ok := m.session(sessionID)
	if !ok {
		return ErrNoSession
	}
	s.mu.Lock()
	h, ok := s.hosts[hostID]
	switch {
	case !ok:
		s.mu.Unlock()
		return ErrNoHost
	case h.fingerprint == "" || h.done:
		s.mu.Unlock()
		return ErrNotConnected
	case h.fingerprint != fingerprint:
		s.mu.Unlock()
		return ErrFingerprintMismatch
	}
	h.confirmed = true
	s.mu.Unlock()
	go m.installHost(s, h)
	return nil
}

// Abort destroys the session's secrets; hosts not yet finished are reported aborted.
func (m *Manager) Abort(sessionID string) {
	m.mu.Lock()
	s, ok := m.sessions[sessionID]
	delete(m.sessions, sessionID)
	m.mu.Unlock()
	if ok {
		s.close()
	}
}

// Expire drops sessions past their expiry (1 h), destroying their secrets.
func (m *Manager) Expire() {
	now := time.Now()
	m.mu.Lock()
	var expired []*Session
	for id, s := range m.sessions {
		if now.After(s.expires) {
			expired = append(expired, s)
			delete(m.sessions, id)
		}
	}
	m.mu.Unlock()
	for _, s := range expired {
		s.close()
	}
}

// finish marks a host done and closes the session when every host is done.
func (m *Manager) finish(s *Session, h *hostState) {
	s.mu.Lock()
	h.done = true
	all := true
	for _, x := range s.hosts {
		all = all && x.done
	}
	s.mu.Unlock()
	if all {
		m.Abort(s.id)
	}
}

func (m *Manager) send(s *Session, h *hostState, u Update) {
	u.OrganizationID = s.org
	m.report(s.id, h.spec.ID, u)
}

func (m *Manager) fail(s *Session, h *hostState, msg string) {
	m.send(s, h, Update{Status: "failed", Error: &msg})
}

func str(s string) *string { return &s }
