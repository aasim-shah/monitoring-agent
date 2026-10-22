package control

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

// State is what an enrolled agent remembers between runs (state.json next to the keys).
type State struct {
	AgentID              string `json:"agentId"`
	ControlURL           string `json:"controlUrl"`
	IngestURL            string `json:"ingestUrl"`
	OpampURL             string `json:"opampUrl"`
	TaskSigningPublicKey string `json:"taskSigningPublicKey"`
	NotAfter             string `json:"notAfter"`
	// ServerName and CAFile are only for development stacks reached by IP address or
	// with a private TLS root; production uses the system roots.
	ServerName string `json:"serverName,omitempty"`
	CAFile     string `json:"caFile,omitempty"`
}

const stateFile = "state.json"

// SaveState writes state.json (mode 0600).
func SaveState(dir string, s *State) error {
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, stateFile), data, 0o600)
}

// LoadState reads state.json.
func LoadState(dir string) (*State, error) {
	data, err := os.ReadFile(filepath.Join(dir, stateFile))
	if err != nil {
		return nil, fmt.Errorf("not enrolled (%w); run pcp-agentctl enroll first", err)
	}
	var s State
	return &s, json.Unmarshal(data, &s)
}

// ServerTLS returns the TLS config for reaching the control plane.
func ServerTLS(serverName, caFile string) (*tls.Config, error) {
	cfg := &tls.Config{MinVersion: tls.VersionTLS12, ServerName: serverName}
	if caFile != "" {
		pemData, err := os.ReadFile(caFile)
		if err != nil {
			return nil, err
		}
		roots := x509.NewCertPool()
		if !roots.AppendCertsFromPEM(pemData) {
			return nil, fmt.Errorf("%s contains no certificates", caFile)
		}
		cfg.RootCAs = roots
	}
	return cfg, nil
}

// HTTPClient builds an HTTP client for a TLS config; long-polls need more than 25 s.
func HTTPClient(cfg *tls.Config) *http.Client {
	return &http.Client{Timeout: 40 * time.Second, Transport: &http.Transport{TLSClientConfig: cfg}}
}

// Connect returns a client presenting the stored agent certificate.
func Connect(dir string, s *State) (*Client, *Identity, error) {
	id, err := LoadIdentity(dir)
	if err != nil {
		return nil, nil, err
	}
	certPem, err := os.ReadFile(filepath.Join(dir, certFile))
	if err != nil {
		return nil, nil, err
	}
	base, err := ServerTLS(s.ServerName, s.CAFile)
	if err != nil {
		return nil, nil, err
	}
	withCert, err := ClientTLS(id, string(certPem), base)
	if err != nil {
		return nil, nil, err
	}
	var opts []Option
	if s.ServerName != "" {
		opts = append(opts, WithServerName(s.ServerName))
	}
	return New(s.ControlURL, HTTPClient(withCert), opts...), id, nil
}
