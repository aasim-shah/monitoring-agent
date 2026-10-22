package control

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	proto "pcp.local/agentprotocol"
)

const protocolVersion = "1.0"

// APIError is a non-2xx answer from the control plane.
type APIError struct {
	Status  int
	Code    string
	Message string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("control plane answered %d %s: %s", e.Status, e.Code, e.Message)
}

// TaskResult is what the agent reports for a delivered task.
type TaskResult struct {
	Status string         `json:"status"`
	Result map[string]any `json:"result,omitempty"`
	Error  string         `json:"error,omitempty"`
}

// RotateResponse carries the new certificate after rotation.
type RotateResponse struct {
	CertificatePem string `json:"certificatePem"`
	ChainPem       string `json:"chainPem"`
	NotAfter       string `json:"notAfter"`
}

// Client talks to the control channel. Before enrollment it needs no client
// certificate; afterwards build its HTTP client with ClientTLS.
type Client struct {
	base       string
	http       *http.Client
	serverName string
	now        func() time.Time
}

// Option configures a Client.
type Option func(*Client)

// WithServerName sends this Host header (and, through the caller's TLS config, SNI) when
// connecting by IP address, as the end-to-end test does.
func WithServerName(name string) Option { return func(c *Client) { c.serverName = name } }

// New returns a client for controlURL (e.g. https://agent.example.com).
func New(controlURL string, httpClient *http.Client, opts ...Option) *Client {
	c := &Client{base: strings.TrimRight(controlURL, "/"), http: httpClient, now: time.Now}
	for _, o := range opts {
		o(c)
	}
	return c
}

// ClientTLS builds a TLS config presenting the agent certificate.
func ClientTLS(id *Identity, certPem string, base *tls.Config) (*tls.Config, error) {
	cert, err := tls.X509KeyPair([]byte(certPem), mustPem(id.key))
	if err != nil {
		return nil, err
	}
	cfg := base.Clone()
	if cfg == nil {
		cfg = &tls.Config{MinVersion: tls.VersionTLS12}
	}
	cfg.Certificates = []tls.Certificate{cert}
	return cfg, nil
}

// Enroll exchanges a one-time token and a CSR for an identity (UC-03-02). No tenant
// identifiers are sent; the control plane derives them from the token (BR-03-03).
func (c *Client) Enroll(ctx context.Context, token string, id *Identity, host proto.EnrollRequestHost, agentVersion string) (*proto.EnrollResponse, error) {
	csr, err := id.CSR("pending")
	if err != nil {
		return nil, err
	}
	var out proto.EnrollResponse
	err = c.do(ctx, http.MethodPost, "/agent/v1/enroll", proto.EnrollRequest{
		ProtocolVersion: protocolVersion,
		EnrollmentToken: token,
		AgentVersion:    agentVersion,
		AgentType:       "host",
		CsrPem:          csr,
		X25519PublicKey: id.X25519PublicKeyBase64(),
		Host:            host,
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// Heartbeat reports liveness; accepted is false for a replayed or reordered sequence.
func (c *Client) Heartbeat(ctx context.Context, hb proto.Heartbeat) (bool, error) {
	hb.ProtocolVersion = protocolVersion
	if hb.SentAt == "" {
		hb.SentAt = c.now().UTC().Format(time.RFC3339)
	}
	if hb.Capabilities == nil {
		hb.Capabilities = []string{}
	}
	var out struct {
		Accepted bool `json:"accepted"`
	}
	if err := c.do(ctx, http.MethodPost, "/agent/v1/heartbeat", hb, &out); err != nil {
		return false, err
	}
	return out.Accepted, nil
}

// PollTasks long-polls for tasks. Tasks whose signature does not verify against the
// control plane's key, or that already expired, are dropped and counted in rejected
// (BR-03-06, BR-03-07).
func (c *Client) PollTasks(ctx context.Context, wait time.Duration, key ed25519.PublicKey) ([]proto.AgentTask, int, error) {
	var out struct {
		Tasks []json.RawMessage `json:"tasks"`
	}
	path := fmt.Sprintf("/agent/v1/tasks?wait=%d", int(wait.Seconds()))
	if err := c.do(ctx, http.MethodGet, path, nil, &out); err != nil {
		return nil, 0, err
	}
	var tasks []proto.AgentTask
	rejected := 0
	for _, raw := range out.Tasks {
		ok, _, err := verifyTask(raw, key)
		var task proto.AgentTask
		if err == nil && ok {
			err = json.Unmarshal(raw, &task)
		}
		if err != nil || !ok {
			rejected++
			continue
		}
		expires, err := time.Parse(time.RFC3339Nano, task.ExpiresAt)
		if err != nil || !c.now().Before(expires) {
			rejected++
			continue
		}
		tasks = append(tasks, task)
	}
	return tasks, rejected, nil
}

// PostResult reports a task's outcome.
func (c *Client) PostResult(ctx context.Context, taskID string, r TaskResult) error {
	return c.do(ctx, http.MethodPost, "/agent/v1/tasks/"+taskID+"/result", r, nil)
}

// PostInventory reports the services discovery found on this host (M6b).
func (c *Client) PostInventory(ctx context.Context, inv proto.Inventory) error {
	return c.do(ctx, http.MethodPost, "/agent/v1/inventory", inv, nil)
}

// Whoami confirms the current certificate is accepted.
func (c *Client) Whoami(ctx context.Context) (string, error) {
	var out struct {
		AgentID string `json:"agentId"`
	}
	if err := c.do(ctx, http.MethodGet, "/agent/v1/whoami", nil, &out); err != nil {
		return "", err
	}
	return out.AgentID, nil
}

// Rotate sends a CSR for the identity's current key and returns the new certificate.
// Call id.Rekey() first to rotate the key as well.
func (c *Client) Rotate(ctx context.Context, id *Identity) (*RotateResponse, error) {
	csr, err := id.CSR("pending")
	if err != nil {
		return nil, err
	}
	var out RotateResponse
	if err := c.do(ctx, http.MethodPost, "/agent/v1/rotate", map[string]string{"csrPem": csr}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) do(ctx context.Context, method, path string, body, out any) error {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, reader)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.serverName != "" {
		req.Host = c.serverName
	}
	res, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	if err != nil {
		return err
	}
	if res.StatusCode >= 300 {
		var e struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		}
		_ = json.Unmarshal(data, &e)
		return &APIError{Status: res.StatusCode, Code: e.Code, Message: e.Message}
	}
	if out == nil || len(data) == 0 {
		return nil
	}
	return json.Unmarshal(data, out)
}

func mustPem(key *ecdsa.PrivateKey) []byte {
	der, err := marshalPKCS8(key)
	if err != nil {
		panic(err)
	}
	return der
}
