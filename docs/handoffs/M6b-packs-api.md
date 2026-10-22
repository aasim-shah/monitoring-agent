# Handoff — M6b packs API and configuration channel

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-22 |
| **Branch** | `feat/m6b-services` |
| **Plan** | M6b plan Task 3 |
| **Workbooks** | WB-11 §4–§6, BR-11-01, BR-11-03, D24 |

## Delivered

`apps/api/src/modules/packs`:

| Route | Auth | Behavior |
|---|---|---|
| `GET /api/v1/monitoring-packs` | session | Catalog: redis, postgresql, mysql, mongodb, kafka, nginx, nodejs. Each has `settings` (JSON Schema), `credentialFields`, and `defaultEndpoint` (loopback). |
| `GET /api/v1/agents/:id/inventory` | `agent.view` | Latest discovery snapshot, plus `suggestedPacks` (detected and not enabled). |
| `GET /api/v1/agents/:id/packs` | `agent.view` | Assignments with status and message. Never the ciphertext. |
| `POST /api/v1/agents/:id/packs` | `pack.manage` | `{ packId, settings, sealedCredentials? }`. 201 when created, 200 when updated. Status becomes `pending` and the agent's `policy_version` is bumped. Returns 409 for a revoked agent. Audited with `credentialsProvided` only. |
| `DELETE /api/v1/agents/:id/packs/:packId` | `pack.manage` | Status becomes `removing` (ciphertext cleared) and the version is bumped. Returns 202. |
| `POST /agent/v1/inventory` | mTLS | Validated against the agent-protocol `inventory` schema. Replaces the previous snapshot. |
| `GET /agent/v1/config` | mTLS | `{ policyVersion, packs: [{ packId, settings, sealedCredentials? }] }`. Rows in `removing` are left out. |
| `POST /agent/v1/config/ack` | mTLS | `{ policyVersion, results: [{ packId, status, message? }] }`. Returns 204. |

- **Settings validation.** Settings are validated per pack (strict zod). Endpoints are `host:port`, or an http(s) URL without credentials for nginx. `sealedCredentials` must be base64, at most 4 KB, and at least 60 bytes (ephemeral key, nonce, and tag).
- **Ack rules.** An ack settles only assignments with `policy_version <= ack.policyVersion`. A change made while the agent was applying stays `pending` and keeps its ciphertext. On settle:
  - The ciphertext is set to null for both `applied` and `failed`.
  - `applied_at` is set for `applied`.
  - `removing` rows are deleted.
- **Agent public key.** `GET /api/v1/agents/:id` now returns `x25519PublicKey`.
- **OpenAPI and client.** OpenAPI is updated: `pack-proposals` is replaced by `inventory`, and the schemas `MonitoringPack`, `PackAssignment`, `Inventory`, and `ListenAddress` are added. The API client is regenerated.

## Notes for Task 4 (agent)

- After an ack, `GET /agent/v1/config` returns the pack without `sealedCredentials`. The agent must keep the credentials it opened (in its state directory, mode 600) and reuse them when later configurations omit them.
- Credentials are also cleared after a `failed` ack. If the agent never stored them, the user re-enters them.

## Tests

`pnpm --filter @pcp/api test` → 27 files, 169 passed. The new tests are in `packs.int.test.ts` (11):
- the catalog
- inventory storage and suggestions
- ciphertext delivered once and absent from every response and audit row after ack
- a stale ack keeps the ciphertext
- a failed ack keeps its message
- removing → ack → gone
- validation
- product scope and permissions (operator on another product → 404, viewer cannot enable → 404, stranger → 404)
- revoked agent → 409
