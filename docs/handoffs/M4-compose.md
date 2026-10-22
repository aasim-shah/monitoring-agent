# Handoff — M4 Compose wiring for the worker

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-22 |
| **Branch** | `feat/m4-connectors` |
| **Plan** | Expansion Task 6 |
| **Workbooks** | WB-02 §12, §13 |

## Summary

The worker now starts in the Compose stack with everything the job processors and schedule reconciler need. Before this change, the M4 worker exited at startup because Compose gave it no database URL or master key.

## Delivered

| File | Change |
|---|---|
| `compose.yaml` (worker) | `DATABASE_URL` (`pcp_app`), `SCHEDULER_DATABASE_URL` (`pcp_scheduler`, `PCP_SCHEDULER_PASSWORD`), `MASTER_KEY`; waits for `migrate` to finish successfully |
| `apps/worker/Dockerfile` | Installs `openssl` (Prisma's musl query engine links OpenSSL 3), same as the API image |
| `tests/smoke/compose.smoke.test.ts` | New: worker `/readyz` is `ready` with `postgres` and `redis` checks, in both deployment modes |
| `docs/workbooks/WB-02-connector-framework-secrets.md` | API list matches the org-scoped routes; §12 checklist ticked; duplicate-connection warning deferred to M5 |

## Tests

| Suite | Result |
|---|---|
| Smoke before the change | `service "worker" is not running` (stack never became healthy) |
| Smoke after the change (managed + self-hosted) | see [M4 execution log](M4-execution-log.md) |

## Operator notes

- `.env` must set `PCP_SCHEDULER_PASSWORD` (already required by `migrate`).
- The mock connector is never enabled in Compose; `PCP_ENABLE_MOCK_CONNECTOR=1` with `NODE_ENV=production` refuses to start.

## Next

- M5: connections UI (catalog, create, credentials form, resource scoping, sync runs) on these routes.
