# Handoff — M8.1 Private connector worker

| | |
|---|---|
| **Status** | Done (end-to-end in Task 7) |
| **Date** | 2026-10-23 |
| **Branch** | `feat/m8-private-worker` |
| **Plan** | M8 plan Task 4 |
| **Workbooks** | WB-07 UC-07-01, BR-07-04/05/07, TC-07-01/02 |

## Delivered

`agents/private-connector-worker` (`@pcp/private-connector-worker`, Node 22, Docker image about 61 MB).

**Commands.** `pcp-private-worker enroll | run | enroll-and-run --token … --control-url … [--ca-file …]`. The `PCP_TOKEN`, `PCP_CONTROL_URL`, `PCP_CA_FILE`, `PCP_STATE_DIR` (`/var/lib/pcp-worker`) and `PCP_SECRETS_DIR` (`/etc/pcp-worker/secrets`) environment variables work as well. `enroll-and-run` is idempotent, so a container restart does not re-enroll.

**Enrollment** follows the host-agent flow with `agentType: private_worker`:
- a P-256 key and a CSR (`@peculiar/x509`), plus an X25519 key
- written to `worker.key`, `worker.crt`, `chain.pem`, `x25519.key` and `state.json`, all mode 0600, in a 0700 directory

**Run loop:**
- a heartbeat every 30 s
- `GET /agent/v1/tasks?wait=25` over mTLS (undici `Agent` with the client certificate)
- certificate rotation at 10 days before expiry
- a 401 stops the worker with a "re-enroll" message

**Task handling:**
- `verifyTask` checks the Ed25519 signature over `canonicalJson` (shared vector) and the expiry. Forged, unsigned and expired tasks are dropped and logged, never run.
- `connector_op` payloads `{ connectionId, provider, operation: validate|health|template, config, template?, params? }` run through `runOp` with the registry: `postgres`, `mysql`, `mongodb`, `custom-http`.
- Credentials come from `loadSecret(config.secretRef)`, which reads `/etc/pcp-worker/secrets/<ref>.yaml`, a flat map of strings. The name must be simple: no `/`, no `..`, no leading `.`, at most 64 characters.
- A connector failure produces `{ status: 'failed', error, result: { operation, reason } }`.
- Results are capped at 256 KB by halving the largest arrays, with `truncated: true` set.
- Other task types are reported as unsupported.

## Notes for Task 5

- The control plane must create `connector_op` tasks with exactly this payload, and read `result.reason` and `result.operation` from failed results.
- The install command for `private_worker` enrollments needs to be the `docker run …` command shown in the Dockerfile header.

## Tests

`pnpm --filter @pcp/private-connector-worker test`: 13 passed. Covered:
- the shared signature vector
- forged, unsigned, expired and wrong-key tasks
- `secretRef` path tricks
- nested or missing secret files
- the 256 KB cap
- `runOp` success, connector failure with its reason, unknown provider, and unsupported operation
