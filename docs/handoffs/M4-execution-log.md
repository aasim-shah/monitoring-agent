# Execution Log — M4 Connectors and Jobs

| | |
|---|---|
| **Plan** | `docs/superpowers/plans/2026-10-22-m4-connectors-jobs.md` |
| **Branch** | `feat/m4-connectors` (stacked on `feat/m3-dashboard-shell` at `5ab8201`) |
| **Executed** | 2026-10-22, inline, test-first |

## Ledger

```text
# SDD ledger — plan: docs/superpowers/plans/2026-10-22-m4-connectors-jobs.md
Spec: spec §9, §14.4, §15.2; master plan M4; WB-02; branch feat/m4-connectors stacked on feat/m3-dashboard-shell (user: "continue" → option 3 + next milestone).
Pre-flight: T1 tables consumed by T3–T5 — consistent; T2 SDK consumed by T3–T5 — consistent; T3 runtime consumed by T4 processors and T5 API — consistent; T4 enqueue consumed by T5 — consistent.
Ruling: connector registry lives in code (no connector_definitions table yet) — catalog is static per release — cost if wrong: one table when per-tenant connector enablement arrives.
Ruling: connection creation route is POST /api/v1/organizations/:orgId/connections (spec §15.2's POST /api/v1/connections has no tenant in the path; updated spec) — cost if wrong: none.
Ruling: ExecutionContext gains credentials() accessor (spec §9 has no way to pass credentials) — cost if wrong: none.
Task 1: complete (commits 5ab8201..b872f54, tests: pnpm turbo run test --filter @pcp/database --filter @pcp/api →   Time:    64ms >>> FULL TURBO)
Task 2: Ruling: Connector.configSchema() returns JSON Schema, not a Zod type (catalog must be renderable by the UI and AI tool registry; spec §9 said ZodTypeAny) — cost if wrong: one adapter.
Task 2: complete (commits b872f54..e3e7b23, tests: pnpm turbo run test --filter @pcp/connector-sdk --filter @pcp/connectors-mock →   Time:    51ms >>> FULL TURBO)
Task 3: Ruling: runtime decrypts credentials eagerly before each operation (tamper test showed lazy decryption hides corrupted ciphertext) — cost if wrong: one decrypt per operation.
Task 3: complete (commits e3e7b23..a76a012, tests: pnpm turbo run test --filter @pcp/connector-runtime →   Time:    23ms >>> FULL TURBO)
Task 4: Ruling: job IDs use '__' separators — BullMQ throws 'Custom Id cannot contain :' (master plan specified ':') — cost if wrong: none.
Task 4: complete (commits a76a012..522e4e4, tests: pnpm turbo run test --filter @pcp/jobs --filter @pcp/worker --filter @pcp/connector-runtime →   Time:    19.632s )
Task 5: Ruling: validate status update made conditional in ConnectorRuntime (Task 3 code) — API delete test exposed a read-then-update race that revived deleted connections — cost if wrong: none, stricter than before
Task 5: Ruling: resource scopes not re-checked against provider discovery — scopes are labels and connectors re-check access per call — cost if wrong: admin can scope a nonexistent external ID
Task 5: complete (commits 522e4e4..97ec514, tests: pnpm turbo run test --filter @pcp/api --filter @pcp/connector-runtime --filter @pcp/jobs →   Time:    35ms >>> FULL TURBO)
Task 6: Ruling: smoke images pre-built sequentially before the smoke run — eight parallel Node builds exceeded the 900 s up timeout on this machine — cost if wrong: none (CI builds per job)
Task 6: complete (commits 97ec514..95d4b11, tests: pnpm test:smoke → 14 passed; pnpm test → 25/25 tasks; pnpm test:e2e → 2 passed (4.8m); test:repo 51 pass)
Final review: self-review (session policy: no subagents unless the user asks)
Final: fixed authorize while pending_validation returned 500 — "accepts credentials again while validation is still pending" RED→GREEN, api 87/87
Final: fixed product-scoped admin resource-scope replace deleted other products' scopes — "a product-scoped admin replaces only their products' scopes" RED→GREEN, api 87/87
Final: minor (deferred): duplicate-connection warning (WB-02 open item) not implemented; lands with the M5 connections UI.
Final: minor (deferred): DELETE leaves already-queued BullMQ jobs in Redis; processors skip them, but they still run once.
Post-close: fixed product form rejected pasted URLs (user report) — schemas.test.ts RED→GREEN; commit 4de8aa2.
```

## Results

- Exit gate met: a mock connection goes `draft → pending_validation → connected` through the API and worker.
- No credential appears in any API response, stored error, or `pg_dump` of `connection_secrets`.
- Full pipeline green: unit/integration 25/25 tasks, smoke 14/14 (both modes), e2e 2/2, repo scripts 51/51, Go tests.

## How to resume

- Next: product setup checklist (user feedback: no path after product creation), then M5 enrollment and M6 host agent.
- Local stack: `docker compose -p pcp-dev -f compose.yaml -f tests/e2e/compose.e2e.yaml --env-file .env up -d` → http://localhost:8090, mail at http://localhost:18225.
