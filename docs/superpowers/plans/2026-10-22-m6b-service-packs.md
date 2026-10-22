# M6b Service Discovery and Monitoring Packs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each server shows the services it runs (Redis, PostgreSQL, MySQL, MongoDB, Kafka, nginx, Node.js) and warns about databases exposed to the internet; the user enables monitoring for a service from the dashboard (entering credentials that only the agent can decrypt), and that service's metrics and charts appear within a minute, with no reinstall.

**Architecture:** The agent's discovery scans listening sockets (`/proc/net/tcp{,6}`), processes (`/proc/<pid>/comm` and `cmdline`, never `environ`), and matches them against pack `detect` rules; it posts an inventory snapshot on the control channel. Enabling a pack creates an assignment and bumps the agent's policy version; the heartbeat response carries the version, the agent fetches its configuration, opens sealed credentials with its X25519 key, regenerates the collector configuration, restarts the collector, and acknowledges, after which the control plane deletes the ciphertext. The collector build gains the service receivers. Service charts use fixed PromQL templates per pack.

**Tech Stack:** Go 1.23 (`golang.org/x/crypto/nacl/box` for sealed boxes), OpenTelemetry Collector v0.162.0 receivers (redis, postgresql, mysql, mongodb, nginx, kafkametrics) and processors (filter), NestJS 11, Prisma 6, Next.js 15, `libsodium-wrappers` (browser `crypto_box_seal`), Recharts.

**Spec:** `AI_Product_Control_Plane_Architecture_and_Flows.md` §8.6, §8.8, §8.10; master plan M6.3 (discovery), M11 (packs), D24 (sealed credentials); WB-11, WB-04.

**Deferred:** OpAMP server/supervisor (configuration travels on the existing mTLS control channel until then), Level 1/2 changes (`pcp-helper`), Docker pack (needs a read-only socket proxy), log collection (M10), live boost, default alert rules (M12), asset graph (M9).

## Global Constraints

- Nothing is collected for a service until a user enables its pack (BR-11-01).
- The agent never reads application configuration or `/proc/<pid>/environ`; credentials come only from the admin (BR-11-02).
- Pack credentials are sealed in the browser to the agent's X25519 key (`crypto_box_seal`); the control plane stores only ciphertext and deletes it once the agent acknowledges (BR-11-03, D24).
- Every compiled collector configuration keeps `memory_limiter` first, a metric allowlist `filter`, and `batch` (BR-11-06).
- Receivers connect to services on loopback by default; the agent never opens a listener.
- Enabling or disabling a pack requires `pack.manage`; viewing requires `agent.view`.
- Configuration changes reach a connected agent within one heartbeat (30 s).

## Review Focus

1. **A pack's credentials appear in an API response, log, or database row after the agent acknowledged.** Expected: never in plaintext anywhere; ciphertext gone after ack. Test in Task 3.
2. **The agent receives a configuration it cannot apply (bad receiver settings).** Expected: the previous collector configuration keeps running, the assignment shows `failed` with the collector's message. Test in Task 4.
3. **Discovery on a host with thousands of processes or unreadable `/proc` entries.** Expected: bounded output, errors skipped, never `environ`. Test in Task 2.
4. **A database listening on `0.0.0.0`.** Expected: a visible "exposed to the internet" warning, not just a service entry. Test in Task 2/5.
5. **Product-scoped member enabling a pack on another product's agent.** Expected: 404. Test in Task 3.

---

### Task 1: Data model (migration 0005)

**Files:** `packages/database/prisma/schema.prisma`, `prisma/migrations/0005_service_packs/migration.sql`, `src/tables.ts`, `src/agents.int.test.ts`

**Interfaces:**
- `agent_inventories` (`agent_id` PK, `organization_id`, `collected_at`, `services jsonb`, `listeners jsonb`, `warnings jsonb`), RLS.
- `agent_pack_assignments` (`id`, `organization_id`, `agent_id`, `pack_id`, `settings jsonb`, `sealed_credentials text?`, `status` enum `pending|applied|failed|removing`, `status_message?`, `policy_version int`, `applied_at?`, `created_by_user_id?`, timestamps; unique `(agent_id, pack_id)`), RLS.

- [ ] Failing test (RLS suite picks up both tables; unique pack per agent) → implement → pass → handoff `M6b-data-model.md` + commit.

### Task 2: Agent discovery

**Files:** `agents/host-agent-go/internal/discovery/{procfs.go,listeners.go,processes.go,match.go,catalog.go}` + tests with fixture trees; `cmd/pcp-agentctl` posts inventory; `packages/agent-protocol/schemas/inventory.schema.json` (+ generated types)

**Interfaces:**
- `Scan(fsys fs.FS) (Inventory, error)` over a procfs-shaped `fs.FS` (tests use `fstest.MapFS`); reads `net/tcp`, `net/tcp6`, `<pid>/comm`, `<pid>/cmdline`, `<pid>/status` (Uid only); **never opens `environ`** (test fails if attempted); at most 2,000 processes and 500 listeners.
- Catalog `detect` rules: redis (`redis-server`, 6379), postgresql (`postgres`, 5432), mysql (`mysqld`/`mariadbd`, 3306), mongodb (`mongod`, 27017), kafka (`java` + cmdline `kafka.Kafka`, 9092), nginx (`nginx`, 80/443), nodejs (`node`/`PM2`, any port).
- `Inventory{ collectedAt, services: [{ pack, name, ports: [{ address, port }], processCount, evidence: string[] }], listeners: [{ address, port }], warnings: [{ kind: 'exposed_service', pack, address, port }] }`; a database/cache pack bound to a non-loopback address yields `exposed_service`.
- `POST /agent/v1/inventory` after start and every 5 minutes.

- [ ] Failing tests (fixtures: redis on 127.0.0.1, postgres on 0.0.0.0 → warning; kafka via cmdline; node processes counted; `environ` never opened; malformed lines skipped; caps) → implement → pass → handoff `M6b-discovery.md` + commit.

### Task 3: Packs API and configuration channel

**Files:** `apps/api/src/modules/packs/{packs.module,catalog,packs.service,packs.controller,agent-config.controller}.ts`, inventory endpoints in agents module, OpenAPI, tests

**Interfaces:**
- `GET /api/v1/monitoring-packs` (session): catalog `{ id, name, description, settings: JSON Schema (endpoint, etc.), credentialFields: [{ name, label }], defaultEndpoint }`.
- `GET /api/v1/agents/:id/inventory` (`agent.view`): latest inventory + `suggestedPacks` (detected but not enabled).
- `GET /api/v1/agents/:id/packs` (`agent.view`): assignments without ciphertext; `POST /api/v1/agents/:id/packs` (`pack.manage`) `{ packId, settings, sealedCredentials? }` (base64 sealed box, ≤ 4 KB) → upsert, status `pending`, bump `agents.policy_version`; `DELETE /api/v1/agents/:id/packs/:packId` (`pack.manage`) → `removing`, bump.
- `GET /api/v1/agents/:id` adds `x25519PublicKey`.
- `GET /agent/v1/config` → `{ policyVersion, packs: [{ packId, settings, sealedCredentials? }] }`; `POST /agent/v1/config/ack` `{ policyVersion, results: [{ packId, status: 'applied'|'failed', message? }] }` → statuses, `applied_at`, **sealed_credentials set to null** for applied packs, `removing` rows deleted.
- Inventory: `POST /agent/v1/inventory` (`@AgentRoute()`).

- [ ] Failing tests (enable → version bump and pending; agent config returns ciphertext once; ack applied deletes ciphertext and no response ever contains it; failed ack keeps status message; delete → removing → ack removes row; product-scoped analyst/other product → 404; viewer cannot enable) → implement → pass → handoff `M6b-packs-api.md` + commit.

### Task 4: Agent applies packs

**Files:** `agents/host-agent-go/internal/collector/{config.go,packs.go}`, `internal/control/{config.go,sealed.go}`, `cmd/pcp-agentctl`, collector `builder-config.yaml`

**Interfaces:**
- `collector.Config(in Input)` gains `Packs []PackConfig{ ID, Settings map[string]any, Credentials map[string]string }`; each pack adds a receiver (`redis`, `postgresql`, `mysql`, `mongodb`, `nginx`, `kafkametrics`, or `host_metrics` `process` scraper for nodejs) to the metrics pipeline; a `filter` processor keeps only `system.*`, `process.*`, and the enabled packs' metric prefixes.
- `control.OpenSealed(sealedB64 string, id *Identity) (map[string]string, error)` (`box.OpenAnonymous`).
- Run loop: heartbeat `policyVersion` ≠ applied → `GET /agent/v1/config` → open credentials → write config → `pcp-otelcol validate` → on success restart collector and ack `applied`; on failure keep previous config and ack `failed` with the validation message (Review Focus #2).
- Collector build adds the six receivers and `filterprocessor` (v0.162.0).

- [ ] Failing tests (config per pack with credentials only in the file; filter allowlist; sealed box opens with the agent key and fails with another; failed validation keeps old config and reports failure) → implement → pass → handoff `M6b-agent-packs.md` + commit.

### Task 5: Services UI and charts

**Files:** `apps/web/components/services/{services-panel,enable-pack-dialog,service-charts}.tsx`, `lib/seal.ts` (`libsodium-wrappers`), host page section, telemetry templates `GET /api/v1/agents/:id/services/:packId/metrics?range=…`

**Behavior:** Host page "Services on this server": detected services with ports, "Exposed to the internet" warning, status (Not monitored / Applying… / Monitoring / Failed + message), "Monitor" button → dialog with endpoint (prefilled, loopback) and credential fields (sealed in the browser; never sent in plaintext) → charts per pack (Redis: memory, ops/s, connected clients, hit ratio; PostgreSQL: connections, commits/s, database size; MySQL: connections, queries/s; MongoDB: connections, operations/s; nginx: requests/s, active connections; Kafka: consumer lag, partitions; Node.js: CPU and memory per process).

- [ ] Failing tests (`seal` round trip with a test key; panel shows warning and statuses; dialog never puts the password in the request body except as sealed ciphertext) → implement → pass → handoff `M6b-services-ui.md` + commit.

### Task 6: End-to-end, deploy, docs

- [ ] `tests/agent-e2e`: systemd host with `redis-server` and `postgresql` installed → inventory lists both → enable Redis (no auth) and PostgreSQL (monitoring user, sealed) through the API → `redis_*` and `postgresql_*` series queryable; ciphertext gone after ack.
- [ ] Full pipeline green; deploy to `monitor.aasimshah.com` (shared-VPS runbook); browser check; WB-11 checklist; board; `M6b-execution-log.md`.
