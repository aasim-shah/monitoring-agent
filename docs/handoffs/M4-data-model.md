# Handoff — M4 data model (migration 0003)

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-22 |
| **Branch** | `feat/m4-connectors` |
| **Plan** | Master M4.1 (storage), M4.3, M4.4; expansion `2026-10-22-m4-connectors-jobs.md` Task 1 |
| **Workbooks** | WB-02 §6 |

## Summary

Seven tenant tables for connections and jobs, all with forced row-level security, plus two narrow `SECURITY DEFINER` functions.

## Delivered

| Table | Purpose |
|---|---|
| `connections` | Provider, display name, execution location (`cloud`/`private`), status (`connection_status` enum), status reason, non-secret config, last validated |
| `connection_secrets` | One row per connection: serialized envelope ciphertext + key version only; deleting it crypto-shreds the credentials |
| `connection_resource_scopes` | Provider resources assigned to products (and optionally environments) |
| `connection_health` | Health checks over time |
| `sync_runs` | Validate/discover/sync runs: status, timing, redacted error, item count |
| `job_definitions` | Persisted schedules (`kind`, `entity_id`, `every_seconds`, `enabled`) |
| `job_executions` | Job outcomes including `dead_letter` |

| Function | Access |
|---|---|
| `pcp_resolve_connection_org(connection, user)` | `pcp_app`; organization only for members |
| `pcp_due_job_definitions()` | `pcp_scheduler` only; enabled schedules across tenants without table access |

`TENANT_TABLES` now lists 14 tables; the RLS suite seeds and checks all of them for both tenants.

## How to verify

```bash
pnpm --filter @pcp/database test   # 39 pass
```

## Tests

| Test | Result |
|---|---|
| RLS enabled and forced, no rows without context, only own rows — all 14 tables | pass |
| `pcp_resolve_connection_org` member vs stranger | pass |
| `pcp_scheduler` can call `pcp_due_job_definitions()` but cannot read `job_definitions` | pass |
| `connection_secrets` columns: only ciphertext, key version, ids, timestamps | pass |
| Schema drift | pass |

## Decisions

- `connection_resource_scopes.environment_id` is validated in the service: Prisma cannot express an optional composite foreign key next to a required `organization_id`.
- Connector definitions stay in code (no `connector_definitions` table yet).

## Next

- Task 2: connector SDK and the test-only mock connector.
