package main

import (
	"errors"
	"fmt"
	"net"
	"regexp"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

// dial connects to a host as the session's user. checkKey sees the host key before authentication.
func (m *Manager) dial(s *Session, h HostSpec, checkKey func(ssh.PublicKey) error) (*ssh.Client, error) {
	s.mu.Lock()
	var auth []ssh.AuthMethod
	if s.mode == "key" && s.signer != nil {
		auth = append(auth, ssh.PublicKeys(s.signer))
	}
	if s.mode == "password" && len(s.password) > 0 {
		pw := string(s.password)
		auth = append(auth, ssh.Password(pw))
	}
	s.mu.Unlock()
	cfg := &ssh.ClientConfig{
		User:    h.Username,
		Auth:    auth,
		Timeout: m.dialTimeout,
		// The dashboard asks the admin to compare the ed25519 key's fingerprint.
		HostKeyAlgorithms: []string{ssh.KeyAlgoED25519, ssh.KeyAlgoECDSA256, ssh.KeyAlgoRSASHA256},
		HostKeyCallback: func(_ string, _ net.Addr, k ssh.PublicKey) error {
			return checkKey(k)
		},
	}
	return ssh.Dial("tcp", net.JoinHostPort(h.Host, strconv.Itoa(h.Port)), cfg)
}

// quote makes a value one single-quoted shell word.
func quote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

// installCommand is the only install command the runner runs (BR-05-02): the platform's install.sh
// with the session's token. sudo reads a password from stdin in password mode.
func installCommand(p InstallParams) string {
	return `f=$(mktemp /tmp/pcp-install.XXXXXX) && curl -fsSL ` + quote(p.InstallScriptURL) + ` -o "$f" && ` +
		`echo "PCP_SCRIPT_SHA256=$(sha256sum "$f" | cut -d' ' -f1)" && ` +
		`sudo -S -p '' bash "$f" --token ` + quote(p.Token) + ` --control-url ` + quote(p.ControlURL) +
		` --download-url ` + quote(p.DownloadURL) + `; rc=$?; rm -f "$f"; exit $rc`
}

// cleanupCommand removes the temporary user and its sudo rule after the session disconnects.
const cleanupCommand = `sudo -n sh -c 'rm -f /etc/sudoers.d/pcp-install; nohup sh -c "sleep 2; pkill -KILL -u pcp-install; userdel -r pcp-install" >/dev/null 2>&1 &'`

// manualCleanup is shown when the runner cannot confirm the cleanup (Review Focus #2).
const manualCleanup = "sudo pkill -u pcp-install; sudo userdel -r pcp-install; sudo rm -f /etc/sudoers.d/pcp-install"

var scriptSHA = regexp.MustCompile(`PCP_SCRIPT_SHA256=([0-9a-f]+)`)

func (m *Manager) installHost(s *Session, h *hostState) {
	defer m.finish(s, h)
	s.mu.Lock()
	want := h.fingerprint
	install := s.install
	password := string(s.password)
	s.mu.Unlock()
	out := newOutput(install.Token, password)
	m.send(s, h, Update{Status: "installing"})
	c, err := m.dial(s, h.spec, func(k ssh.PublicKey) error {
		if ssh.FingerprintSHA256(k) != want {
			return errors.New("host key changed since it was confirmed")
		}
		return nil
	})
	if err != nil {
		msg := err.Error()
		if strings.Contains(msg, "host key changed") {
			msg = "aborted: the host key changed since it was confirmed"
		}
		m.fail(s, h, redact(msg, install.Token, password))
		return
	}
	defer c.Close()
	sess, err := c.NewSession()
	if err != nil {
		m.fail(s, h, err.Error())
		return
	}
	sess.Stdout, sess.Stderr = out, out
	if s.mode == "password" {
		sess.Stdin = strings.NewReader(password + "\n")
	}
	stop := make(chan struct{})
	go func() {
		t := time.NewTicker(2 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-stop:
				return
			case <-t.C:
				m.send(s, h, Update{Status: "installing", Output: str(out.String())})
			}
		}
	}()
	runErr := sess.Run(installCommand(install))
	close(stop)
	text := out.String()
	var version *string
	if v := scriptSHA.FindStringSubmatch(text); v != nil {
		version = &v[1]
	}
	if runErr != nil {
		m.send(s, h, Update{Status: "failed", Output: &text, ScriptVersion: version, Error: str(redact(fmt.Sprintf("install failed: %v", runErr), install.Token, password))})
		if s.mode == "key" {
			m.cleanup(s, h, c, &text, version, "failed")
		}
		return
	}
	if s.mode == "password" {
		m.send(s, h, Update{Status: "installed", Output: &text, ScriptVersion: version, Cleanup: str("not_needed")})
		return
	}
	m.cleanup(s, h, c, &text, version, "installed")
}

// cleanup removes pcp-install, then proves it by failing to log in with the session key (TC-05-07).
func (m *Manager) cleanup(s *Session, h *hostState, c *ssh.Client, text *string, version *string, status string) {
	report := func(cleanup string, errMsg *string) {
		m.send(s, h, Update{Status: status, Output: text, ScriptVersion: version, Cleanup: &cleanup, Error: errMsg})
	}
	if sess, err := c.NewSession(); err == nil {
		_ = sess.Run(cleanupCommand)
	}
	_ = c.Close()
	time.Sleep(m.cleanupWait)
	for attempt := 0; attempt < 5; attempt++ {
		again, err := m.dial(s, h.spec, func(ssh.PublicKey) error { return nil })
		if err != nil && strings.Contains(err.Error(), "unable to authenticate") {
			report("done", nil)
			return
		}
		if again != nil {
			_ = again.Close()
		}
		time.Sleep(time.Second + m.cleanupWait)
	}
	report("failed", str("the temporary user could not be confirmed removed; run on the server: "+manualCleanup))
}
