# Handoff — M6b data model (migration 0005)

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-22 |
| **Branch** | `feat/m6b-services` |
| **Plan** | M6b plan Task 1 |
| **Workbooks** | WB-11 §6, BR-11-03 |

## Delivered

| Table | Purpose |
|---|---|
| `agent_inventories` | Latest discovery snapshot per agent: `services`, `listeners`, `warnings` (JSON), `collected_at` |
| `agent_pack_assignments` | Pack enabled on an agent: `pack_id`, `settings`, `sealed_credentials` (ciphertext only, cleared after the agent acknowledges), `status` `pending/applied/failed/removing`, `status_message`, `policy_version`, `applied_at`; unique `(agent_id, pack_id)` |

Both tables have forced row-level security; `TENANT_TABLES` now lists 24 tables.

## Tests

`pnpm --filter @pcp/database test` → 66 passed (RLS suite covers both new tables; one-pack-per-agent uniqueness).
