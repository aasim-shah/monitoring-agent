# Handoff — M16 Automation engine

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-24 |
| **Branch** | `feat/m16-actions` |
| **Plan** | M16 plan Task 2 |
| **Workbooks** | WB-16 BR-16-01/02/03/09, TC-16-01/02/03/07/08 |

## Delivered

`packages/automation`:

- **Capabilities:**

  | Capability | Target | Validation |
  |---|---|---|
  | `host.restart_service` | agent | unit names only (`^[A-Za-z0-9@._-]+\.service$`) |
  | `cloudflare.purge_cache` | zone (32-hex zone ID) | ≤ 30 https URLs, or everything, which needs 2 approvals |
  | `github.workflow_dispatch` | repo | workflow file and ref |

  Each defines its target key and how many approvals it needs.
- **`evaluatePolicy`:**
  - no policy or a disabled one gives `rejected_policy`
  - checks the allowlist (units, zones, workflow plus ref)
  - auto-approves only outside production, under a no-approval policy, and never for the AI
- **`canApprove`:**
  - the approver needs one of the policy's roles (default: owner/admin in production, plus operator elsewhere)
  - no self-approval in production
  - one decision per person
  - a second distinct approver when two are needed
- **`transition`:** the WB-16 state machine.
- **`assessImpact`:** the dry-run summary from asset graph dependents.
- **Adapters**, both reporting their verification:
  - `cloudflarePurge`: verified by the API success flag
  - `githubDispatch`: verified when a run appears within 30 s

## Tests

- **Automation** (17): policy decisions, approvals, unit validation (Review Focus #2), state transitions, impact, and the adapters against fake HTTP.
