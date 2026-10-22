# M8 Private Connector Worker, Databases, and Custom REST Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A customer runs one private connector worker inside their network. Through it, the dashboard shows PostgreSQL, MySQL, and MongoDB health and runs named read-only aggregate templates, without database credentials ever reaching the control plane. Any HTTP API can be connected through a custom REST connector that cannot be pointed at internal addresses.

**Architecture:**
- **The worker.** The private worker is a small Node service (`agents/private-connector-worker`) with the same identity model as the host agent:
  - enrollment token → CSR → mTLS client certificate
  - long-polling of Ed25519-signed tasks
- **Running connectors.** For `connector_op` tasks the worker runs the shared TypeScript connectors (`packages/connectors/*`). It loads credentials from local `secretRef` files and returns bounded results.
- **The control plane.** It stores private connections with `workerAgentId` and `secretRef` in non-secret config, and queues signed `connector_op` tasks (validate, health, template). When a private worker polls, the control plane creates the health tasks that are due (every 5 minutes); a separate scheduler is not needed. Results update the connection status and the `connection_health` rows.
- **Custom REST.** The custom REST connector goes through an SSRF guard that resolves DNS once and connects to the vetted address.

**Tech Stack:** Node 22 + TypeScript, `pg`, `mysql2`, `mongodb` drivers, `yaml`, `@peculiar/x509` (CSR), undici `Agent` with a custom `lookup` (pinned address), NestJS 11, Prisma 6, Next.js 15, Testcontainers.

**Spec:** `AI_Product_Control_Plane_Architecture_and_Flows.md` §4.6, §7.3, §7.6, §18.1; master plan M8 (M8.1–M8.3), §3 limits; WB-07; WB-03 (identity reuse).

**Deferred:**
- KPI storage of template results (`metric_aggregates`, M13 KPIs). M8 returns and stores the last result on the connection.
- Custom REST OAuth and mTLS auth (API key and bearer only).
- Internal Prometheus/Grafana connectors.
- A worker systemd package (Docker image only; systemd with M17).

## Global Constraints

- **Credential storage (BR-07-01).** Database credentials stay in the customer network. The control plane stores only an opaque `secretRef`.
- **`secretRef` names (BR-07-07).** A `secretRef` is a simple name, `^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`, with no `/` and no `..`.
- **No free-form queries (BR-07-02).** Only named, reviewed aggregate templates may run.
- **Read-only users (BR-07-03).** Database users must be read-only. A write-capable user fails with `permission_denied` unless an admin acknowledges an audited override.
- **Bounds (BR-07-04).**
  - Worker results: at most 256 KB, truncated with `truncated: true`.
  - Database statement timeout: 5 s.
  - Rows: at most 1,000.
- **Signed tasks only (BR-07-05).** The worker executes only signed, unexpired tasks.
- **SSRF blocklist (BR-07-06).** For central execution the SSRF guard blocks:
  - `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`
  - `169.254.0.0/16`, `0.0.0.0/8`, `100.64.0.0/10`
  - `::1`, `::`, `fc00::/7`, `fe80::/10`
  - IPv4-mapped forms of all of the above
- **Custom REST bounds.** Responses are capped at 1 MB with a 10 s timeout, at most 3 redirects (each re-validated), and at most 100 pages.
- **TLS to databases.** On by default. Non-TLS needs an explicit `allowInsecure: true` in config, and it is audited.

## Review Focus

1. **DNS rebinding.** The first lookup returns a public address and the second a private one. Expected: the request goes to the vetted address only, or is refused. Covered in Task 1.
2. **A template that writes.** A template body containing `INSERT`, `UPDATE`, `DELETE`, DDL, or `$out`/`$merge`. Expected: impossible to register (type check plus runtime check), and the database session is read-only anyway. Covered in Task 2.
3. **Worker given a task for another organization's connection, or a forged or expired task.** Expected: refused. A connection's `workerAgentId` must belong to the same organization. Covered in Tasks 4 and 5.
4. **A huge result** (5,000 rows, or a 10 MB document). Expected: truncated to the limits with a flag, never an out-of-memory crash. Covered in Tasks 2 and 4.
5. **Worker offline.** Expected: the connection shows `degraded` with "worker offline", never zeros or a fake healthy state. Covered in Task 5.

---

### Task 1: SSRF guard and pinned HTTP client

**Files:** `packages/connector-sdk/src/ssrf-guard.ts` (+ test). `http-client.ts` gains a `destination` option.

**Interfaces:**
- `assertPublicDestination(url: URL, opts: { allowPrivate: boolean; allowlist?: string[]; lookup?: LookupFn }): Promise<{ address: string; family: 4 | 6 }>`.
  - Rejects non-http(s) schemes and credentials in the URL.
  - Rejects every blocked range for central execution.
  - With `allowPrivate`, a private address is allowed only if its host (or `host:port`) is in `allowlist`.
- `createHttpClient({ destination?: { allowPrivate, allowlist?, lookup? } })`:
  - every request resolves once through the guard, then connects to that address (undici `Agent` `connect.lookup` pinned)
  - redirects are handled manually (at most 3, each re-guarded)

- [ ] Failing tests:
  - each address in TC-07-07, plus `[::ffff:127.0.0.1]` and `100.64.0.1`
  - a hostname resolving to private
  - rebinding (lookup returns public, then private; the connection goes to the first)
  - a redirect to `169.254.169.254`
  - private execution: allowlisted `10.1.2.3` allowed, `10.9.9.9` refused
  - a non-http scheme

  Then implement, pass, write handoff `M8-ssrf.md`, and commit.

### Task 2: Database connectors

**Files:** `packages/connectors/{postgres,mysql,mongodb}/src/{index,templates,health,privileges}.ts` + `*.int.test.ts` (Testcontainers), and `packages/connector-sdk/src/templates.ts`.

**Interfaces:**
- `defineTemplate({ name, description, engine: 'postgres'|'mysql'|'mongodb', query, params: ['from','to'] })`.
  - SQL templates must be one statement starting with `SELECT` or `WITH`. Templates with `;` (except trailing), `INTO`, DML/DDL keywords, or `pg_`/`lo_` write functions are rejected.
  - Mongo templates are an aggregation pipeline without `$out`/`$merge`/`$function`/`$where`.
  - The type is a branded `ReadOnlyTemplate`.
- Each connector (`type`: `postgres`, `mysql`, `mongodb`; `executionLocations: ['private']`):
  - **`validate(ctx)`.** Connects with TLS unless `allowInsecure` is set, checks privileges, and returns `{ ok, missingPermissions? }`. A write-capable user produces `ConnectorError('permission_denied', …)` unless `config.writeOverrideAcknowledged === true`.
  - **`health(ctx)`** returns `{ ok, detail }`, where `detail` is JSON of the WB-07 health table fields:
    - PostgreSQL: connections, max_connections, replication lag, database sizes, `pg_stat_statements` top 10 or `"extension not installed"`
    - MongoDB: `serverStatus` connections, replica set state/lag, `dbStats`
    - MySQL: `Threads_connected`, `max_connections`, replica lag, schema sizes, slow queries
  - **`runTemplate(ctx, name, { from, to })`** (new optional method on `Connector`) returns `{ rows, truncated }`.
  - Every session sets a 5 s statement timeout and read-only mode: PostgreSQL `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY` plus `statement_timeout`; MySQL `SET SESSION TRANSACTION READ ONLY` plus `MAX_EXECUTION_TIME`; MongoDB `maxTimeMS` with a secondary-preferred read.
- Starter templates:
  - PostgreSQL: `table_row_estimates`, `rows_created_per_day` (param `table`, `column` from config, identifier-quoted)
  - MySQL: `table_row_estimates`
  - MongoDB: `documents_per_day` (collection and date field from config)

- [ ] Failing tests:
  - for each engine (Testcontainers): health fields populated; a read-only user validates; a user with INSERT gets `permission_denied`; the override is accepted
  - a 5,000-row template returns 1,000 rows with `truncated: true`
  - write templates fail at definition
  - wrong password gives `authentication`, unreachable gives `network`

  Then implement, pass, write handoff `M8-database-connectors.md`, and commit.

### Task 3: Custom REST connector

**Files:** `packages/connectors/custom-http/src/{index,mapping}.ts` + tests.

**Interfaces:**
- Config: `{ baseUrl, auth: { kind: 'none'|'api_key_header'|'bearer', headerName? }, endpoints: [{ name, path, query?, itemsPath?, metrics: [{ name, path, unit? }], pagination?: { param, start, max } }], allowPrivate?: boolean, allowlist?: string[] }`.
  - The credential field is `token`.
  - Paths are JSON paths of the form `$.a.b[0].c`.
- `validate` calls the first endpoint and requires JSON.
- `collect` extracts the metric values per endpoint. Non-JSON responses give `ConnectorError('invalid_response', sanitized)`.
- `executionLocations: ['cloud', 'private']`. Cloud execution always passes `allowPrivate: false`.

- [ ] Failing tests (local HTTP server through an injected lookup):
  - mapping extraction
  - HTML response gives `invalid_response`
  - pagination stops at `max` (≤ 100) with a warning
  - a cloud config pointing to `127.0.0.1` is refused by the guard
  - the bearer token never appears in errors

  Then implement, pass, write handoff `M8-custom-rest.md`, and commit.

### Task 4: Private connector worker

**Files:** `agents/private-connector-worker/src/{main,enroll,client,task-loop,secrets,ops}.ts` + tests, plus a `Dockerfile` (target `private-worker` in `agents/release/Dockerfile`).

**Interfaces:**
- `pcp-private-worker enroll --token … --control-url … [--ca-file …]` writes `/var/lib/pcp-worker/{worker.key,worker.crt,chain.pem,state.json}` (mode 0600). `pcp-private-worker run`.
- `verifyTask(task, publicKey)` checks the Ed25519 signature over `canonicalJson(task without signature)` and that `expiresAt` is in the future. Anything else is rejected and reported as `failed: rejected`.
- `loadSecret(secretRef, dir = '/etc/pcp-worker/secrets')` accepts names per BR-07-07 only. It reads `<dir>/<ref>.yaml`, a flat map of strings.
- `runOp(task.payload)` takes a payload of `{ connectionId, provider, operation: 'validate'|'health'|'template', config, template?, params? }`. It runs the connector from the registry (postgres, mysql, mongodb, custom-http) with `executionLocation: 'private'` and returns `{ status, result }`.
- Results are capped at 256 KB: the largest arrays are trimmed and `truncated: true` is set.
- Enrollment for `private_worker` returns an install command `docker run -d --name pcp-private-worker --restart unless-stopped -v pcp-worker:/var/lib/pcp-worker -v /etc/pcp-worker/secrets:/etc/pcp-worker/secrets:ro <image> enroll-and-run --token … --control-url …`.

- [ ] Failing tests:
  - forged, unsigned, and expired tasks are refused
  - `secretRef` values `../x`, `a/b`, and `` are refused
  - a 600 KB result is truncated with the flag
  - an unknown provider produces a failed result
  - the shared `task-signature.json` vector verifies

  Then implement, pass, write handoff `M8-private-worker.md`, and commit.

### Task 5: Control plane for private connections

**Files:** `apps/api/src/modules/connections/{private-ops.service,private-ops.int.test}.ts`, plus changes to the connections service, schemas, and controller, and to the agents tasks service result hook. OpenAPI.

**Interfaces:**
- Creating a connection with `executionLocation: 'private'`:
  - requires `config.workerAgentId`, an active `private_worker` in the same organization, otherwise 400
  - requires `config.secretRef` per BR-07-07
  - rejects any `credentials` field, because credentials stay local
- Validating a private connection creates a signed `connector_op` task for the worker (`operation: 'validate'`) and sets the status to `validating`.
- **Health.** When a `private_worker` polls (`TasksService.poll`), `PrivateOpsService.ensureDue(agent)` queues a health task for each of its connections whose last health is older than 5 minutes and that has none pending.
- **Result hook.** `connector_op` results update the connection:
  - status `connected`, `permission_denied`, or `failed` with a reason
  - a `connection_health` row (detail JSON, ≤ 256 KB)
  - `lastValidatedAt`
- **Worker offline.** If the worker is `degraded` or stale, `GET /connections/:id` reports `status: degraded` with `statusReason: worker_offline`.
- **Templates.** `POST /api/v1/connections/:id/templates/:name/run { from, to }` (`connection.configure`) queues a `template` operation. `GET /api/v1/connections/:id/health` returns the latest health and the last template result.
- **Override.** `POST /api/v1/connections/:id/write-override` (`connection.configure`) sets `writeOverrideAcknowledged`. It is audited, and the warning stays visible.

- [ ] Failing tests:
  - a private connection with another organization's worker gives 400
  - `secretRef` `../x` gives 400
  - credentials on a private connection give 400
  - validate creates a signed task for that worker only
  - a result moves the status to connected and writes a health row
  - a stale worker shows `worker_offline`
  - a due health task is created on poll and not duplicated
  - a viewer cannot run a template (404)

  Then implement, pass, write handoff `M8-private-connections.md`, and commit.

### Task 6: Databases page

**Files:** `apps/web/app/(app)/orgs/[orgId]/products/[productId]/databases/page.tsx`, `components/databases/{worker-panel,add-database-dialog,database-health}.tsx`, `lib/nav.ts`.

**Behavior:**
- **Private workers panel.** Lists the workers with their status, and an "Add private worker" button. The button creates an enrollment with `agentType: private_worker` and shows the `docker run` command.
- **Add database dialog.** Choose the type, the worker, host, port, database, TLS, and `secretRef`. Each engine shows:
  - its "create a read-only user" SQL
  - the secrets file snippet (`/etc/pcp-worker/secrets/<ref>.yaml` with `username`/`password`)
- **Database list.** Shows status (Connected, Validating…, Permission denied with an override button, Worker offline) and health tiles (connections vs max, size, replication lag, slow queries or "extension not installed").
- The nav enables Databases.

- [ ] Failing tests:
  - the dialog never asks for a password and builds `config.secretRef`
  - the read-only SQL is shown per engine
  - statuses render
  - the override is hidden without `connection.configure`

  Then implement, pass, write handoff `M8-databases-ui.md`, and commit.

### Task 7: Exit gate, deploy, docs

- [ ] `tests/agent-e2e`: start a private worker container and a MongoDB container with a FireMaps-like fixture (collections with documents) on the e2e network. Then enroll the worker through Caddy mTLS, create a private MongoDB connection with `secretRef`, and check that validate becomes `connected` and health shows connections and `dbStats` sizes. Assert that no credential appears in the control-plane database (`pg_dump | grep`).
- [ ] Full pipeline once.
- [ ] Deploy (the private-worker image goes to the downloads/registry path).
- [ ] Browser check, WB-07 checklist, board, `M8-execution-log.md`.
