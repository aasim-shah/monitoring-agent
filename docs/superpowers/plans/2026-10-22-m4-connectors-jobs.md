# M4 Connector SDK, Connection Lifecycle, Jobs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver master-plan M4: encrypted connection secrets, the connector SDK (contract, registry, lifecycle state machine, bounded HTTP client, circuit breaker, redaction), a connector runtime that loads connections only inside the caller's tenant and product scope, the BullMQ job framework with persisted schedules and dead letters, and the connections API — proven by taking a test-only mock connector from `draft` to `connected` through the API and worker.

**Architecture:** Migration 0003 adds `connections`, `connection_secrets`, `connection_resource_scopes`, `connection_health`, `sync_runs`, `job_definitions`, `job_executions` with forced RLS. `@pcp/connector-sdk` holds pure SDK pieces; `@pcp/connectors-mock` is a test-only connector excluded from production (dev dependency, refused when `NODE_ENV=production`). `@pcp/connector-runtime` (DB-aware) executes operations with decrypted credentials and maps connector errors to statuses and reasons. `@pcp/jobs` defines queues, deterministic job IDs, the schedule reconciler, dead-letter recording, and the connection processors the worker runs. The API enqueues jobs; the worker executes them.

**Tech Stack:** M3 stack plus BullMQ 5.81.5.

**Spec:** spec §4.3, §4.7, §7.1, §9, §9.1, §13.1, §14.1, §14.4, §15.2; master plan M4.1–M4.4, D5, D9, §3 (connector HTTP client, jobs), §4.2, §4.7; workbook WB-02; ADR 0004, 0008.

## Global Constraints

- All master-plan Global Constraints apply.
- Secret values never appear in API responses, logs, job payloads, or `sync_runs`/`job_executions` rows.
- Job payloads carry only `{ organizationId, connectionId, requestId }` set server-side; workers rebuild tenant context from them.
- A connector declares a capability if and only if it implements the matching method; the registry rejects mismatches.
- `@pcp/connectors-mock` is a dev dependency only and is refused at startup when `NODE_ENV=production`.
- Values from §3: HTTP timeout 10 s, max response 5 MB, 3 retries with jitter honoring `Retry-After`; jobs 5 attempts, exponential backoff base 10 s, then dead letter.

## Review Focus

1. **A secret value echoed by a provider error message.** Expected: runtime redacts credential values from every error and log line before storing or returning it. Test in Task 3.
2. **Connection used by a product-scoped member outside their products.** Expected: `not_found`. Test in Task 3.
3. **The same job enqueued twice (double click, retry).** Expected: runs once (deterministic job ID). Test in Task 4.
4. **Worker restarts while schedules exist.** Expected: every `job_definitions` schedule is present in BullMQ after reconcile. Test in Task 4.
5. **Deleting a connection while a sync runs.** Expected: the secret is unrecoverable and the job ends without reviving the connection. Test in Task 5.

---

### Task 1: Migration 0003 — connection and job tables (master M4.1, M4.3, M4.4 data)

**Files:**
- Modify: `packages/database/prisma/schema.prisma`, `packages/database/src/tables.ts`
- Create: `packages/database/prisma/migrations/0003_connections_jobs/migration.sql`
- Test: existing `rls.int.test.ts` (automatically covers new `TENANT_TABLES`), `schema-drift.int.test.ts`, new `connections.int.test.ts`

**Interfaces:**
- Tables: `connections` (`status`, `status_reason`, `provider`, `execution_location`, `config`, `display_name`, `last_validated_at`), `connection_secrets` (one row per connection: `ciphertext` text = serialized `EncryptedSecret`, `key_version`), `connection_resource_scopes` (`external_id`, `resource_type`, `name`, `product_id`, `environment_id?`), `connection_health` (`checked_at`, `ok`, `reason`, `detail`), `sync_runs` (`kind` validate|discover|sync, `status` queued|running|succeeded|failed|cancelled, `started_at`, `finished_at`, `error_code`, `error_message`, `items`), `job_definitions` (`kind`, `entity_id`, `every_seconds`, `enabled`), `job_executions` (`job_id`, `kind`, `status`, `attempts`, `error`).
- Functions: `pcp_resolve_connection_org(p_connection uuid, p_user uuid) returns uuid`; `pcp_due_job_definitions()` (for `pcp_scheduler`) returns `(organization_id, id, kind, entity_id, every_seconds)` of enabled definitions.

- [ ] **Step 1: Failing tests** — `connections.int.test.ts`: `pcp_resolve_connection_org` returns the organization for members and NULL for strangers; `pcp_scheduler` can call `pcp_due_job_definitions()` but cannot `SELECT` from `job_definitions`; `connection_secrets` has no plaintext column (only `ciphertext`, `key_version`). RLS suite and drift test pick up the new tables.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Handoff + commit** — `docs/handoffs/M4-data-model.md`.

### Task 2: Connector SDK and mock connector (master M4.2, M4.3 pure parts)

**Files:**
- Create: `packages/connector-sdk/src/{types,errors,registry,state-machine,http-client,circuit-breaker,redaction,index}.ts`, `packages/connectors/mock/src/index.ts`
- Test: `packages/connector-sdk/src/{registry,state-machine,http-client,circuit-breaker,redaction}.test.ts`, `packages/connectors/mock/src/mock.test.ts`

**Interfaces:**
- Types per spec §9 (`Connector`, `ExecutionContext` + `credentials(): Promise<Record<string,string>>`, `ConnectionValidation { ok: boolean; accountId?: string; missingPermissions?: string[] }`, `DiscoveryPage`, `HealthResult { ok: boolean; detail?: string }`).
- `ConnectorError(reason: ConnectionReason | 'invalid_config', message, opts?: { retryAfterSeconds?: number })`.
- `ConnectorRegistry.register(c)`, `.get(type)`, `.list()` → catalog entries `{ type, version, displayName, capabilities, executionLocations, configSchema (JSON Schema) }`; rejects capability/method mismatch and duplicates.
- `transition(from, event)` per spec §9.1 / WB-02 diagram; `StatusEvent = 'auth_started' | 'auth_completed' | 'validated' | 'validation_failed' | 'degraded' | 'recovered' | 'revoked' | 'disconnected'`.
- `createHttpClient({ fetch?, timeoutMs = 10_000, maxBytes = 5 * 1024 * 1024, retries = 3, sleep? })` → `request(url, init)`; retries 429/5xx/network with jitter, honors `Retry-After`, aborts bodies over `maxBytes`.
- `CircuitBreaker({ failureThreshold = 5, resetAfterMs = 30_000, now? })` → `run(fn)`; throws `ConnectorError('provider_unavailable')` while open.
- `redactSecrets(text, secrets: string[]): string` (replaces each value of length ≥ 4 with `[REDACTED]`).
- Mock connector `type: 'mock'`, capabilities `config_validation, validate, discover, health`; config `{ behavior: 'ok' | 'unauthorized' | 'forbidden' | 'rate_limited' | 'unavailable' | 'leaky'; resources?: number }` (`leaky` throws an error that contains the credential).

- [ ] **Step 1: Failing tests** — registry rejects `sync` declared without `sync()` and duplicates; state machine allows the spec transitions and throws on `draft → validated`; HTTP client retries 503 then succeeds, honors `Retry-After: 2`, stops after 3 retries, aborts 6 MB body; breaker opens after 5 failures and half-opens after 30 s; redaction; mock behaviors.
- [ ] **Step 2–4** → FAIL → implement → PASS.
- [ ] **Step 5: Handoff + commit** — `docs/handoffs/M4.2-connector-sdk.md`.

### Task 3: Connector runtime (master M4.2 runtime, M4.1 storage)

**Files:**
- Create: `packages/connector-runtime/src/{runtime,secrets,index}.ts`
- Test: `packages/connector-runtime/src/runtime.int.test.ts`

**Interfaces:**
- `storeCredentials(tx, ctx, connectionId, credentials: Record<string,string>, keyRing)`; AAD `"<organizationId>:<connectionId>"`.
- `ConnectorRuntime(prisma, registry, keyRing, opts?: { now?: () => Date })`:
  - `run<T>(ctx, connectionId, op: 'validate' | 'discover' | 'health', ...args): Promise<T>` — loads the connection with `withTenant`; product-scoped callers need a resource scope on one of their products, else `not_found`; builds `ExecutionContext`; redacts credentials from any thrown message.
  - `validate(ctx, connectionId)` → runs validate, applies `transition`, sets `status_reason`, writes `connection_health`, returns `{ status, reason?, missingPermissions? }`.

- [ ] **Step 1: Failing tests** — connection of another org → `not_found`; product-scoped member without a scope on their product → `not_found` (Review Focus #2); mock `ok` → `connected`; `unauthorized` → `degraded` + `reauthorization_required`; `forbidden` → `permission_denied`; `rate_limited` keeps status, reason `rate_limited`; `leaky` error message stored without the secret (Review Focus #1); `pg_dump` of `connection_secrets` contains no plaintext; tampering the row's organization breaks decryption.
- [ ] **Step 2–4** → FAIL → implement → PASS.
- [ ] **Step 5: Handoff + commit** — `docs/handoffs/M4.2-connector-runtime.md`.

### Task 4: Job framework and worker processors (master M4.4)

**Files:**
- Create: `packages/jobs/src/{queues,job-id,reconciler,dead-letter,processors,index}.ts`
- Modify: `apps/worker/src/{main,config}.ts`, `apps/worker/package.json`
- Test: `packages/jobs/src/{job-id.test.ts,jobs.int.test.ts}`

**Interfaces:**
- Queues: `connection-validate`, `connection-discover`. `jobId(kind, organizationId, entityId, window?)` → `"<kind>:<org>:<entity>[:<window>]"`.
- `enqueue(queues, kind, payload: { organizationId; connectionId; requestId })` with `jobId`, attempts 5, exponential backoff 10 s.
- `reconcileSchedules(prisma (scheduler role), queues)` → upserts BullMQ job schedulers for every enabled definition; removes stale ones.
- `startProcessors(deps)` → BullMQ `Worker`s that run `ConnectorRuntime.validate` / discover, write `sync_runs` and `job_executions`; final failure → `dead_letter`.

- [ ] **Step 1: Failing tests** — same job enqueued twice → one run (Review Focus #3); reconcile after "restart" (new reconciler instance) → schedulers match definitions (Review Focus #4); a job failing 5 times → `job_executions.status = 'dead_letter'`; validate processor moves a mock connection to `connected` and records a succeeded `sync_runs` row.
- [ ] **Step 2–4** → FAIL → implement → PASS.
- [ ] **Step 5: Handoff + commit** — `docs/handoffs/M4.4-jobs.md`.

### Task 5: Connections API (master M4.3)

**Files:**
- Create: `apps/api/src/modules/connections/{connections.module,connections.controller,connections.service,catalog.controller,registry.provider,schemas}.ts`
- Modify: `apps/api/src/common/{decorators,tenant.guard}.ts` (connection scope), `docs/architecture/openapi-v1.yaml`, spec §15.2 (`POST /api/v1/organizations/:orgId/connections`, `GET` list)
- Test: `apps/api/src/modules/connections/connections.int.test.ts`; tenant matrix covers new routes

**Interfaces:**
- `GET /api/v1/connectors/catalog` (session only); `POST /api/v1/organizations/:orgId/connections` (`connection.configure`) → `draft`; `GET /api/v1/organizations/:orgId/connections` (`connection.view`); `GET /api/v1/connections/:id` (`connection.view`); `POST /api/v1/connections/:id/authorize` (`{ credentials }` → encrypted, `pending_validation`, validate job queued); `POST /api/v1/connections/:id/validate` (202, queued); `GET /api/v1/connections/:id/resources` (runs discover); `POST /api/v1/connections/:id/resource-scopes`; `POST /api/v1/connections/:id/discover` (202); `GET /api/v1/connections/:id/sync-runs`; `DELETE /api/v1/connections/:id` (crypto-shred, `disconnected`).
- `@TenantScope({ param: 'id', resource: 'connection' })`.

- [ ] **Step 1: Failing tests** — mock connection `draft → pending_validation → connected` via API + in-process processors (exit gate); every response body in the test scanned for the credential value (none); config validation errors → 400; resources and resource scopes; delete → secret row gone, status `disconnected`, a queued validate afterwards does not revive it (Review Focus #5); viewer cannot create (404); mock refused when `NODE_ENV=production`; `@pcp/connectors-mock` is not in API `dependencies`.
- [ ] **Step 2–4** → FAIL → implement → PASS.
- [ ] **Step 5: Handoff + commit** — `docs/handoffs/M4.3-connections-api.md`.

### Task 6: Compose, smoke, docs

**Files:**
- Modify: `compose.yaml` (worker: `DATABASE_URL`, `MASTER_KEY`, depends on `migrate`), `tests/smoke/compose.smoke.test.ts` (worker ready with DB), `docs/workbooks/WB-02-connector-framework-secrets.md`, `docs/handoffs/README.md`

- [ ] **Step 1: Failing test** — smoke: worker `/readyz` reports postgres and redis checks.
- [ ] **Step 2–4** → FAIL → implement → PASS; full pipeline, smoke, e2e green.
- [ ] **Step 5: Handoff + commit** — `docs/handoffs/M4-compose.md`.
