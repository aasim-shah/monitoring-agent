# Handoff — M5 agent data model

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-22 |
| **Branch** | `feat/m5-onboarding-agents` |
| **Plan** | `docs/superpowers/plans/2026-10-22-m5-agent-identity.md` Task 1 |
| **Workbooks** | WB-03 §6, BR-03-01, BR-03-03 |

## Summary

Migration `0004_agents` adds the tables behind agent enrollment, identity, heartbeats, signed tasks, and stream sessions. Every table has forced row-level security. Four narrow SECURITY DEFINER functions cover the lookups that happen before a tenant context exists.

## Delivered

| Object | Purpose |
|---|---|
| `agent_enrollments` | Token **hash** (HMAC, never the token), product, environment, expiry, `max_uses`, `uses`, revocation |
| `agents` | One row per enrolled host: tenant scope from the enrollment, host facts, `status` `active`/`revoked` (degraded and stale are derived from heartbeats), last heartbeat and sequence, clock skew |
| `agent_credentials` | Certificate fingerprint (SHA-256 hex), serial, `not_after`, `superseded_at` (rotation grace), `revoked_at` |
| `agent_public_keys` | X25519 key per agent for sealed pack credentials (D24) |
| `agent_heartbeats`, `agent_tasks`, `agent_task_results`, `agent_stream_sessions` | Heartbeat history, signed tasks with status `queued → delivered → succeeded/failed` or `expired`, results, stream sessions |
| `pcp_consume_enrollment(hash)` | One conditional `UPDATE … RETURNING`: never exceeds `max_uses` under concurrency; zero rows for unknown, expired, exhausted, or revoked tokens. `pcp_rls_definer` gets `UPDATE (uses)` only. |
| `pcp_agent_by_fingerprint(fp)` | Tenant fields and credential state for the mTLS guard |
| `pcp_resolve_agent_org/product(agent, user)` | Member-only resolution for the tenant guard |

## Tests

| Suite | Result |
|---|---|
| `agents.int.test.ts` (single use; expired/revoked/unknown → nothing; 10 parallel consumes on `max_uses 3` → exactly 3; fingerprint lookup; member-only resolution; no rows without tenant context) | 6 passed |
| RLS suite (8 new tables seeded for two tenants) and schema drift | passed; database total 61 |

## Next

- Task 2: agent CA and certificate issuance.
