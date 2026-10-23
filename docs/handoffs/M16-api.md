# Handoff — M16 Actions API

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-24 |
| **Branch** | `feat/m16-actions` |
| **Plan** | M16 plan Task 4 |
| **Workbooks** | WB-16 §7, UC-16-02..10, TC-16-01/02/03/04/09/10 |

## Delivered

| Route | Behavior |
|---|---|
| `GET /api/v1/products/:id/action-policies` | Every capability per environment; disabled by default. Cloudflare and GitHub are `available: false` until M7. |
| `PUT /api/v1/products/:id/action-policies/:type` | Requires `org.settings.manage`; audited. |
| `POST /api/v1/actions/proposals` | Product in the body. Validates the environment, the host in that environment, and agent ≥ 0.3.0 (409 `agent_upgrade_required`). Provider actions answer 409 `connection_required`. Then the policy check and the impact from the asset graph. An idempotency key returns the original request. |
| `GET /api/v1/products/:id/actions` | |
| `GET /api/v1/actions/:id` | With approvals and executions. |
| `GET /api/v1/actions/:id/executions` | |
| `POST /api/v1/actions/:id/approve` | `action.propose` plus one of the policy's approver roles; 403 `self_approval` in production. |
| `POST /api/v1/actions/:id/reject` | A note is required. |

**Execution:**
- A complete approval claims the target and issues a new signed `action` task (TTL 600 s, `approvalId`, resource scope `{agentId, unit}`). A busy target waits as `approved`.
- The helper's result is verified: the unit must be `active`. Otherwise the action fails with the reason.
- The audit row `action.execute` carries every BR-16-08 field.
- A linked incident gets a timeline note.
- The next waiting request on the same target then starts.

**Expiry** is lazy: undecided requests after 1 h, executions whose task outlived its TTL and runtime.

**AI:** the tool `proposeAction` creates `proposedByAi` requests, which always wait. The scripted provider routes "restart X.service on agent <id>" to it.

**Agent tasks** now carry and sign `approvalId`.

## Tests

- **API actions tests** (12):
  - TC-16-01 and its audit
  - policies disabled by default, then pending with impact
  - the allowlist and agent version
  - idempotency
  - permissions and cross-tenant 404s
  - TC-16-02 self-approval, then a signed task
  - success with all audit fields (TC-16-10)
  - TC-16-09 a failed verification
  - TC-16-04 one execution at a time per target
  - reject with a note, and expiry
  - listing
  - AI proposals staying pending (TC-16-03)
- **Also:** the full API suite passes, 256/256.
