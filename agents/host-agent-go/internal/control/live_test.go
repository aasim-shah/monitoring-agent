package control

import (
	"context"
	"crypto/ed25519"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"errors"
	"net/http"
	"os"
	"testing"
	"time"

	proto "pcp.local/agentprotocol"
)

// TestLiveControlFlow is the M5 exit gate against a running stack through Caddy's mTLS
// edge. It runs only when tests/agent-e2e sets PCP_CONTROL_URL; that harness creates the
// enrollment, queues a diagnostics task once the agent appears, and revokes the agent
// after it sees the rotated certificate.
func TestLiveControlFlow(t *testing.T) {
	url := os.Getenv("PCP_CONTROL_URL")
	if url == "" {
		t.Skip("PCP_CONTROL_URL not set")
	}
	serverName := os.Getenv("PCP_SERVER_NAME")
	caPem, err := os.ReadFile(os.Getenv("PCP_SERVER_CA"))
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(caPem) {
		t.Fatal("PCP_SERVER_CA has no certificates")
	}
	base := &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: roots, ServerName: serverName}
	clientFor := func(cfg *tls.Config) *Client {
		return New(url, &http.Client{Timeout: 40 * time.Second, Transport: &http.Transport{TLSClientConfig: cfg}}, WithServerName(serverName))
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()

	id, err := GenerateIdentity(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	enrolled, err := clientFor(base).Enroll(ctx, os.Getenv("PCP_ENROLL_TOKEN"), id, proto.EnrollRequestHost{Hostname: "e2e-host", MachineId: "e2e-machine", Os: "linux", Arch: "amd64"}, "1.0.0")
	if err != nil {
		t.Fatalf("enroll: %v", err)
	}
	if err := id.SaveCertificate(enrolled.CertificatePem, enrolled.ChainPem); err != nil {
		t.Fatal(err)
	}
	withCert, err := ClientTLS(id, enrolled.CertificatePem, base)
	if err != nil {
		t.Fatal(err)
	}
	c := clientFor(withCert)
	if got, err := c.Whoami(ctx); err != nil || got != enrolled.AgentId {
		t.Fatalf("whoami = %q, %v; want %s", got, err, enrolled.AgentId)
	}
	if hb, err := c.Heartbeat(ctx, proto.Heartbeat{Sequence: 1, AgentVersion: "1.0.0", PolicyVersion: 1, Capabilities: []string{"host.health"}, Health: "ok"}); err != nil || !hb.Accepted {
		t.Fatalf("heartbeat accepted=%v err=%v", hb.Accepted, err)
	}

	key, _ := base64.StdEncoding.DecodeString(enrolled.TaskSigningPublicKey)
	var task *proto.AgentTask
	for task == nil && ctx.Err() == nil {
		tasks, rejected, err := c.PollTasks(ctx, 20*time.Second, ed25519.PublicKey(key))
		if err != nil {
			t.Fatalf("poll: %v", err)
		}
		if rejected > 0 {
			t.Fatalf("%d tasks failed signature or expiry checks", rejected)
		}
		if len(tasks) > 0 {
			task = &tasks[0]
		}
	}
	if task == nil || task.Type != "inspect" || task.Payload["target"] != "agent_info" {
		t.Fatalf("unexpected task %+v", task)
	}
	if err := c.PostResult(ctx, task.Id, TaskResult{Status: "succeeded", Result: map[string]any{"hostname": "e2e-host", "agentId": enrolled.AgentId}}); err != nil {
		t.Fatalf("result: %v", err)
	}

	if err := id.Rekey(); err != nil {
		t.Fatal(err)
	}
	rotated, err := c.Rotate(ctx, id)
	if err != nil {
		t.Fatalf("rotate: %v", err)
	}
	newTLS, err := ClientTLS(id, rotated.CertificatePem, base)
	if err != nil {
		t.Fatal(err)
	}
	c = clientFor(newTLS)
	if _, err := c.Whoami(ctx); err != nil {
		t.Fatalf("whoami after rotation: %v", err)
	}

	for ctx.Err() == nil {
		_, err := c.Whoami(ctx)
		var apiErr *APIError
		if errors.As(err, &apiErr) && apiErr.Status == http.StatusUnauthorized {
			return
		}
		if err != nil {
			t.Fatalf("waiting for revocation: %v", err)
		}
		time.Sleep(time.Second)
	}
	t.Fatal("agent was not revoked in time")
}
