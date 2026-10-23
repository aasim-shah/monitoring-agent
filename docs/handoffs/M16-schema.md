# Handoff — M16 Actions schema (migration 0011)

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-24 |
| **Branch** | `feat/m16-actions` |
| **Plan** | M16 plan Task 1 |
| **Workbooks** | WB-16 §6, BR-16-01/06 |

## Delivered

- **Tables**, each with forced RLS:

  | Table | Holds |
  |---|---|
  | `action_policies` | `enabled` (default false), approver roles, `require_approval` (default true), allowlist settings; unique per product, environment, and capability |
  | `action_requests` | status enum, target, `target_key`, impact, `proposed_by_ai`, idempotency key (unique per organization), incident link, `expires_at` |
  | `action_approvals` | one decision per user |
  | `action_executions` | location, adapter and version, agent task, status, timing, result, verification, error |

- **One running execution per target:** a unique nullable `running_key`, cleared when the execution finishes.
- **Tenant guard:** `pcp_resolve_action_object` for requests and policies.

## Tests

- **Database** (`actions.int.test.ts`, 5): RLS, the disabled default, one running execution per target, idempotency keys, and the resolver.
- **Also:** the RLS seed and schema drift.
