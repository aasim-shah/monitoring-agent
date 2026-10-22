# Handoff — M5 Go control client and the exit gate

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-22 |
| **Branch** | `feat/m5-onboarding-agents` |
| **Plan** | M5 plan Task 8; master M5 exit gate |
| **Workbooks** | WB-03 UC-03-02..06, TC-03-11, Review Focus #4 |

## Summary

The agent side of the control channel now exists in Go (`agents/host-agent-go`, standard library only). The M5 exit gate passes: against the real Compose stack, through Caddy's mTLS edge, a Go client enrolls, heartbeats, receives and verifies a signed task, answers it, rotates its certificate, and is then revoked.

## Delivered

| File | Behavior |
|---|---|
| `internal/control/keys.go` | `GenerateIdentity(dir)` writes `agent.key` (P-256) and `x25519.key` with mode 0600 and refuses to overwrite; `LoadIdentity`, `Rekey`, `CSR`, `X25519PublicKeyBase64`, `SaveCertificate` |
| `internal/control/canonical.go` | `canonicalJSON` matching `@pcp/agent-protocol` byte for byte (numbers kept as `json.Number`); `verifyTask` (Ed25519 over the task without `signature`) |
| `internal/control/client.go` | `New(url, httpClient, WithServerName?)`, `ClientTLS`, `Enroll`, `Heartbeat`, `PollTasks` (drops tasks with a bad signature or past expiry and counts them), `PostResult`, `Whoami`, `Rotate`; non-2xx → `*APIError{Status, Code, Message}` |
| `internal/control/live_test.go` | `TestLiveControlFlow`, run by the harness below |
| `tests/agent-e2e/control.e2e.test.ts` (`pnpm test:agent-e2e`) | Generates a PKI (`agent:pki`), starts the stack with `Caddyfile.local` and Mailpit, signs up an owner with MFA, creates product/environment/enrollment, copies Caddy's local root, runs the Go test on the Compose `edge` network, queues diagnostics once the agent appears, revokes after the certificate rotates |
| `scripts/go.sh` | `GO_DOCKER_NETWORK` attaches the Go container to a Compose network; `PCP_*` variables pass through |
| Go Dockerfiles (`ingest-gateway`, `opamp-server`) | Copy `agents/host-agent-go` because `go.work` lists it (the first e2e run caught the broken build) |

## Tests

| Suite | Result |
|---|---|
| `go test ./agents/host-agent-go/...` (canonical cases identical to TS; non-integers rejected; shared TS-signed vector verifies and a tampered copy fails; key files 0600 and P-256 CSR; no overwrite; client flow against `httptest` TLS with a tampered and an expired task dropped; API errors) | ok |
| `pnpm test:agent-e2e` (exit gate) | 1 passed |
| `pnpm test:repo` | 51 passed |

## Next

- Task 9: "Add server" dialog and fleet pages.
- M6 builds `pcp-agentctl` on this package.
