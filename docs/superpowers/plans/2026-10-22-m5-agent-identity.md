# M5 Agent Enrollment and Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A customer clicks "Add server", copies an install command, and an agent on their VPS gets its own certificate, heartbeats, receives signed tasks, rotates, and can be revoked. The fleet is visible in the dashboard.

**Architecture:** The API gains an `agents` module: an online intermediate CA issues client certificates from host-generated CSRs; Caddy terminates mTLS on `agent.` and forwards the certificate fingerprint; an agent guard trusts that header only from Caddy's fixed address. Enrollment tokens are single-purpose, hashed, and atomically consumed by a SECURITY DEFINER function. Tasks are Ed25519-signed and long-polled. A Go control client (the core of M6's `pcp-agentctl`) proves the protocol end to end.

**Tech Stack:** NestJS 11 / Fastify 5, Prisma 6 + PostgreSQL 17 (RLS), Redis (ioredis pub/sub), `@peculiar/x509` + WebCrypto, `node:crypto` Ed25519, Go 1.23 (`crypto/x509`, `crypto/ecdh`, `crypto/ed25519`), Caddy 2 `client_auth`, Next.js 15 + TanStack Query, Playwright.

**Spec:** `AI_Product_Control_Plane_Architecture_and_Flows.md` §6.4, §8.2–§8.7, §15.3, §16.1; master plan `docs/superpowers/plans/2026-10-21-ai-product-control-plane.md` M5, D10, D11, D14, §3, §4.4; workbooks WB-03, WB-05.

## Global Constraints

- Enrollment token: default expiry 1 h (max 24 h); default `max_uses` 1; stored as SHA-256 with server pepper; shown once.
- Agent certificate: ECDSA P-256, `CN=<agentId>`, EKU `clientAuth`, 30 days; rotate at day 20; old certificate accepted for 1 h after rotation.
- Heartbeat every 30 s; `degraded` after 90 s without heartbeat; shown stale after 5 min.
- Tasks: long-poll wait 25 s; default TTL 10 min; Ed25519-signed (`TASK_SIGNING_KEY`).
- No agent message contains an organization, product, or environment identifier (§4.4).
- Revocation effective within 30 s (fingerprint cache TTL ≤ 30 s).
- `X-Client-Cert-Fingerprint` is trusted only from Caddy's network address.
- Every denial on user routes is 404; agent routes answer 401 for any authentication failure.
- Private keys never leave the host; the API never sees an agent private key.

## Review Focus

1. **Two hosts racing one `max_uses: 1` token.** Expected: exactly one enrolls; the other gets the same `invalid_enrollment_token` as an unknown token. Test in Task 3.
2. **Fastify `trustProxy` makes `req.ip` attacker-controlled via `X-Forwarded-For`.** Expected: the agent guard checks the socket peer address, so a forged `X-Forwarded-For: <caddy ip>` does not make the fingerprint header trusted. Test in Task 4.
3. **Agent offline for 2 h, then reconnects.** Expected: tasks whose `expiresAt` passed are never delivered; a revoked agent gets 401 and nothing. Test in Task 6.
4. **TS signer and Go verifier disagree on canonical JSON** (key order, unicode, numbers). Expected: one shared test vector verifies in both languages. Tests in Tasks 6 and 8.
5. **A product-scoped analyst opens the fleet page.** Expected: they see only agents enrolled into their products; another product's agent ID is 404. Test in Task 5.

---

### Task 1: Migration 0004 — agent tables and definer functions (master M5.2, M5.4, M5.5 data)

**Files:**
- Modify: `packages/database/prisma/schema.prisma`, `packages/database/src/tables.ts`
- Create: `packages/database/prisma/migrations/0004_agents/migration.sql`
- Test: `packages/database/src/agents.int.test.ts`; existing `rls.int.test.ts` and `schema-drift.int.test.ts` pick up new tables

**Interfaces:**
- Tables (all with `organization_id`, forced RLS, composite FKs to `(organization_id, id)` as in 0003):
  - `agent_enrollments` (`product_id`, `environment_id`, `agent_type` enum `host|private_worker`, `token_hash` unique, `expires_at`, `max_uses`, `uses` default 0, `revoked_at?`, `created_by_user_id?`, `created_at`)
  - `agents` (`product_id`, `environment_id`, `enrollment_id`, `agent_type`, `status` enum `active|revoked` — `degraded` is derived, see Task 5 —, `hostname`, `machine_id`, `os`, `arch`, `agent_version`, `capabilities text[]`, `policy_version int default 1`, `last_heartbeat_at?`, `last_sequence bigint?`, `clock_skew_seconds int?`, `revoked_at?`, `created_at`)
  - `agent_credentials` (`agent_id`, `fingerprint_sha256` unique lowercase hex, `serial`, `not_after`, `superseded_at?`, `revoked_at?`, `created_at`)
  - `agent_public_keys` (`agent_id`, `kind` `x25519`, `public_key`), unique `(agent_id, kind)`
  - `agent_heartbeats` (`agent_id`, `received_at`, `sent_at`, `sequence bigint`, `health`, `queue_depth`, `agent_version`, `policy_version`)
  - `agent_tasks` (`agent_id`, `type`, `payload jsonb`, `resource_scope jsonb`, `expires_at`, `max_runtime_seconds`, `max_response_bytes`, `approval_id?`, `signature`, `status` enum `queued|delivered|succeeded|failed|expired`, `delivered_at?`, `created_by_user_id?`, `created_at`)
  - `agent_task_results` (`task_id` PK, `agent_id`, `status` `succeeded|failed`, `result jsonb?`, `error?`, `received_at`)
  - `agent_stream_sessions` (`agent_id`, `task_id`, `status` `open|closed`, `expires_at`, `created_at`)
- Functions (owner `pcp_rls_definer`, `EXECUTE` to `pcp_app` only):
  - `pcp_consume_enrollment(p_token_hash text) RETURNS TABLE (id uuid, organization_id uuid, product_id uuid, environment_id uuid, agent_type text, created_by_user_id uuid)` — a single `UPDATE … SET uses = uses + 1 WHERE token_hash = $1 AND uses < max_uses AND expires_at > now() AND revoked_at IS NULL RETURNING …`; zero rows for every failure.
  - `pcp_agent_by_fingerprint(p_fingerprint text) RETURNS TABLE (agent_id uuid, organization_id uuid, product_id uuid, environment_id uuid, agent_status text, not_after timestamptz, superseded_at timestamptz, credential_revoked_at timestamptz)`
  - `pcp_resolve_agent_org(p_agent uuid, p_user uuid) RETURNS uuid` and `pcp_resolve_agent_product(p_agent uuid, p_user uuid) RETURNS uuid` (members only, like `pcp_resolve_connection_org`).

- [ ] **Step 1: Failing tests** — `agents.int.test.ts`: `pcp_consume_enrollment` returns the row once for `max_uses 1` and zero rows on the second call, for an expired row, for a revoked row, and for an unknown hash; 10 parallel calls on `max_uses 3` return exactly 3 rows (Review Focus #1); `pcp_agent_by_fingerprint` returns tenant fields for a known fingerprint and nothing for unknown; `pcp_resolve_agent_org` is NULL for non-members; `pcp_app` cannot `SELECT` `agent_enrollments` without tenant context.
- [ ] **Step 2: Run** `pnpm --filter @pcp/database test` → FAIL (functions missing).
- [ ] **Step 3: Implement** schema, migration, `TENANT_TABLES` (+8 tables).
- [ ] **Step 4: Run** → PASS, including RLS and drift suites.
- [ ] **Step 5: Handoff + commit** — `docs/handoffs/M5-data-model.md`.

### Task 2: Agent CA and certificate issuance (master M5.1)

**Files:**
- Create: `apps/api/src/modules/agents/ca/{ca.service.ts,csr.ts}`, `apps/api/scripts/agent-pki.mjs`
- Modify: `apps/api/src/config.ts` (agent settings), `apps/api/package.json` (`@peculiar/x509`, script `agent:pki`), `.env.example`
- Test: `apps/api/src/modules/agents/ca/ca.service.test.ts`, `apps/api/src/config.test.ts`

**Interfaces:**
- Config (all optional together; when absent, enrollment answers 503 `agent_enrollment_unavailable`): `AGENT_CA_CERT` and `AGENT_CA_KEY` (base64 of PEM: intermediate certificate + PKCS#8 P-256 key), `AGENT_CA_CHAIN` (base64 PEM intermediate + root), `TASK_SIGNING_KEY` (base64 PKCS#8 Ed25519), `AGENT_CONTROL_URL`, `AGENT_INGEST_URL`, `AGENT_OPAMP_URL`, `AGENT_PROXY_ADDRESSES` (comma-separated IPs; default empty = trust nobody). `AppConfig.agents?: { caCertPem; caKeyPem; chainPem; taskSigningKeyPem; controlUrl; ingestUrl; opampUrl; proxyAddresses: string[] }`.
- `class AgentCa { static fromPem(certPem, keyPem, chainPem): Promise<AgentCa>; issue(csrPem: string, agentId: string, now?: Date): Promise<{ certificatePem: string; chainPem: string; notAfter: string; serial: string; fingerprintSha256: string }> }` — validity `now − 5 min … now + 30 days`; subject `CN=<agentId>`; EKU `clientAuth`; key usage `digitalSignature`; serial 16 random bytes; the CSR signature must verify.
- `parseCsr(csrPem): { publicKeyAlgorithm: 'P-256' }` throws `InvalidCsrError` for any other key or bad signature.
- `apps/api/scripts/agent-pki.mjs --out <dir>` writes `root.pem`, `intermediate.pem`, `chain.pem` (for Caddy), and prints the `AGENT_CA_*` and `TASK_SIGNING_KEY` lines for `.env`. The root key is written to `root.key` with mode 0600 and a "keep offline" note.

- [ ] **Step 1: Failing tests** — issued certificate: `CN=<agentId>`, EKU contains `1.3.6.1.5.5.7.3.2`, `notAfter − notBefore` = 30 days + 5 min, verifies against the intermediate, which verifies against the root; RSA-2048 CSR and P-384 CSR → `InvalidCsrError`; tampered CSR → `InvalidCsrError`; `fingerprintSha256` equals SHA-256 of the DER as lowercase hex. Config: partial agent settings → startup error naming the missing variable.
- [ ] **Step 2: Run** `pnpm --filter @pcp/api exec vitest run src/modules/agents/ca src/config.test.ts` → FAIL.
- [ ] **Step 3: Implement** with `@peculiar/x509` (`X509CertificateGenerator`, `Pkcs10CertificateRequest`) on `globalThis.crypto`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Handoff + commit** — `docs/handoffs/M5.1-agent-ca.md`.

### Task 3: Enrollment (master M5.2)

**Files:**
- Create: `apps/api/src/modules/agents/{agents.module,enrollments.controller,enrollments.service,enroll.controller,enroll.service,tokens,schemas}.ts`
- Modify: `apps/api/src/app.module.ts`, `apps/api/src/common/{decorators,tenant.guard}.ts` (resource `agent`), `docs/architecture/openapi-v1.yaml`, spec §15.3
- Test: `apps/api/src/modules/agents/enrollment.int.test.ts`

**Interfaces:**
- `POST /api/v1/environments/:environmentId/agent-enrollments` (`agent.enroll`, scope `environmentId`) body `{ agentType?: 'host' (default) | 'private_worker'; maxUses?: 1..1000 (default 1); expiresInMinutes?: 5..1440 (default 60) }` → 201 `{ id, token, expiresAt, maxUses, installCommand }`. `token` = `pcp_enr_` + 32 random bytes base64url. Stored hash = HMAC-SHA-256(pepper, token) hex, pepper = HKDF-SHA-256(MASTER_KEY, info `pcp-enrollment-pepper`). `installCommand` = `curl -fsSL <APP_ORIGIN>/install.sh | sudo bash -s -- --token <token> --control-url <AGENT_CONTROL_URL>`.
- `GET /api/v1/environments/:environmentId/agent-enrollments` (`agent.view`) → `{ enrollments: [{ id, agentType, expiresAt, maxUses, uses, revokedAt, createdAt }] }` (never the token or hash); `POST /api/v1/agent-enrollments/:id/revoke` is deferred to Task 7 with agent revocation.
- `POST /agent/v1/enroll` (`@AgentEnroll()` — no certificate, rate limit 10/min/IP) body `EnrollRequest` (validated by `validateMessage('enroll-request', …)`; 400 `invalid_request` on failure; `protocolVersion` other than `1.0` → 426 `upgrade_required`). Consumes the token via `pcp_consume_enrollment`; any failure → 401 `{ code: 'invalid_enrollment_token' }` with identical body and timing path. On success, inside one tenant transaction: create `agents` row, issue certificate (Task 2), insert `agent_credentials` and `agent_public_keys`, audit `agent.enrolled` (actor `system`, metadata `{ enrollmentId, hostname }`). Response 201 `EnrollResponse`.
- `EnrollmentTokens.hash(token: string): string` in `tokens.ts`.

- [ ] **Step 1: Failing tests** — token appears in the creation response only; DB holds only its HMAC (TC-03-01); expired, exhausted, revoked, and unknown tokens return byte-identical 401 bodies apart from `requestId` (TC-03-02); two concurrent enrolls on `max_uses 1` → one 201 and one 401 (Review Focus #1); request with `organizationId` → 400 (TC-03-03); `protocolVersion: '2.0'` → 426; the agent row's org/product/environment come from the enrollment, not the request; the returned certificate's CN is the new agent ID; viewer creating an enrollment → 404; agent settings absent → 503 `agent_enrollment_unavailable`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS, plus the tenant matrix (enroll route is exempt via `@AgentEnroll()`; the matrix test accepts `AgentEnroll` and `AgentRoute` metadata as guarded).
- [ ] **Step 5: Handoff + commit** — `docs/handoffs/M5.2-enrollment.md`.

### Task 4: Agent authentication and the mTLS edge (master M5.3)

**Files:**
- Create: `apps/api/src/modules/agents/{agent-auth.guard,agent-identity.cache}.ts`, `infrastructure/caddy/Caddyfile.local`
- Modify: `apps/api/src/common/decorators.ts` (`AgentRoute`, `AgentEnroll`), `apps/api/src/modules/identity/current-user.guard.ts` and `apps/api/src/common/{tenant.guard,request}.ts` (skip agent routes; `req.agent`), `infrastructure/caddy/Caddyfile.production` (agent site `client_auth mode verify_if_given`), `compose.yaml` (`edge` subnet `172.30.0.0/24`, caddy `ipv4_address: 172.30.0.10`; API env `AGENT_PROXY_ADDRESSES: 172.30.0.10` and pass-through `AGENT_CA_CERT`, `AGENT_CA_KEY`, `AGENT_CA_CHAIN`, `TASK_SIGNING_KEY`, `AGENT_CONTROL_URL`, `AGENT_INGEST_URL`, `AGENT_OPAMP_URL` as `${VAR:-}`)
- Test: `apps/api/src/modules/agents/agent-auth.int.test.ts`

**Interfaces:**
- `@AgentRoute()` — guard requires a trusted fingerprint; sets `req.agent: { id, organizationId, productId, environmentId }` and `req.tenant` (`actor: { kind: 'agent', agentId }`, `roles: []`, `productIds: [productId]`, `environmentIds: [environmentId]`).
- Trust rule: `req.raw.socket.remoteAddress` (IPv4-mapped IPv6 normalized) ∈ `proxyAddresses`; `req.ip` and `X-Forwarded-For` are ignored.
- `AgentIdentityCache(ttlMs = 30_000, now)`: `get(fingerprint)` caches `pcp_agent_by_fingerprint` rows, including negative results for 30 s.
- Accept iff agent `active`, credential not revoked, `now < not_after`, and (`superseded_at` is null or `now < superseded_at + 1 h`). Any failure → 401 `{ code: 'agent_unauthorized' }`.
- Caddy agent site: `verify_if_given` so `/agent/v1/enroll` works before the agent has a certificate; every other agent route still requires the forwarded fingerprint. Ingest stays `require_and_verify`.
- `Caddyfile.local`: like production but with `tls internal`, sites `agent.localhost` and `ingest.localhost` on `:443`, `app` on `:80`, for a laptop stack (`CADDY_CONFIG=Caddyfile.local`).

- [ ] **Step 1: Failing tests** (inject the socket address through `app.inject({ remoteAddress })`): valid fingerprint from `172.30.0.10` → 200 on a probe route; same header from `10.0.0.5` → 401 (TC-03-05); `remoteAddress` untrusted plus `X-Forwarded-For: 172.30.0.10` → 401 (Review Focus #2); unknown fingerprint → 401; revoked agent → still 200 at +29 s with cache, 401 at +31 s (TC-03-06, fake clock); expired credential → 401; superseded credential → 200 at +59 min, 401 at +61 min; user session cookie on an agent route → 401; agent fingerprint on a user route → 401.
- [ ] **Step 2–4** → FAIL → implement → PASS.
- [ ] **Step 5: Handoff + commit** — `docs/handoffs/M5.3-agent-auth.md`.

### Task 5: Heartbeats and fleet status (master M5.4)

**Files:**
- Create: `apps/api/src/modules/agents/{heartbeat.controller,agents.controller,agents.service,status}.ts`
- Modify: OpenAPI
- Test: `apps/api/src/modules/agents/{status.test.ts,fleet.int.test.ts}`

**Interfaces:**
- `POST /agent/v1/heartbeat` (`@AgentRoute()`) body `Heartbeat` (schema-validated) → 202 `{ accepted: boolean; policyVersion: number }`. Sequence ≤ `last_sequence` → `accepted: false`, nothing stored. `|sentAt − now| > 300 s` → stored with `clock_skew_seconds`. Updates `last_heartbeat_at`, `last_sequence`, `agent_version`, `capabilities`; inserts `agent_heartbeats`.
- `agentStatus(a: { status: 'active' | 'revoked'; lastHeartbeatAt: Date | null; createdAt: Date }, now: Date): { status: 'active' | 'degraded' | 'revoked'; stale: boolean }` in `status.ts`. Degraded after 90 s without heartbeat (from `lastHeartbeatAt ?? createdAt`); stale after 300 s.
- `GET /api/v1/products/:productId/agents` (`agent.view`) → `{ agents: AgentSummary[] }`, `AgentSummary = { id, hostname, os, arch, agentVersion, environmentId, environmentName, status, stale, lastHeartbeatAt, clockSkewSeconds, duplicateMachineId: boolean, createdAt }`.
- `GET /api/v1/agents/:id` (`agent.view`, `@TenantScope({ param: 'id', resource: 'agent' })`) → `AgentSummary & { capabilities, policyVersion, certificate: { notAfter, fingerprintSha256 }, recentHeartbeats: [{ receivedAt, health, queueDepth }] (last 20) }`.

- [ ] **Step 1: Failing tests** — `status.test.ts`: 89 s → active, 91 s → degraded, heartbeat → active, 301 s → stale, revoked wins (TC-03-07). `fleet.int.test.ts`: heartbeat with sequence 5 then 4 → second `accepted: false` and `last_sequence` stays 5; skewed `sentAt` (+10 min) → accepted and `clockSkewSeconds ≈ 600`; two agents with the same `machine_id` → both `duplicateMachineId: true`; product-scoped analyst sees only their product's agents and gets 404 on another's (Review Focus #5); tenant B gets 404.
- [ ] **Step 2–4** → FAIL → implement → PASS.
- [ ] **Step 5: Handoff + commit** — `docs/handoffs/M5.4-heartbeats.md`.

### Task 6: Signed tasks and streams (master M5.5)

**Files:**
- Create: `apps/api/src/modules/agents/{task-signer,tasks.service,tasks.controller,agent-tasks.controller,streams.controller}.ts`, `packages/agent-protocol/testdata/task-signature.json`
- Modify: `packages/agent-protocol/src/index.ts` (export `canonicalJson`), OpenAPI
- Test: `apps/api/src/modules/agents/{task-signer.test.ts,tasks.int.test.ts}`, `packages/agent-protocol/src/canonical.test.ts`

**Interfaces:**
- `canonicalJson(value: unknown): string` in `@pcp/agent-protocol`: object keys sorted by UTF-16 code unit, no whitespace, `JSON.stringify` escaping, integers only (non-integer numbers throw). Signed bytes = UTF-8 of `canonicalJson(task without signature)`.
- `TaskSigner.fromPem(pkcs8Pem)`: `sign(task: Omit<AgentTask, 'signature'>): string` (base64 Ed25519), `publicKeyBase64(): string` (raw 32-byte key, base64) — this is `EnrollResponse.taskSigningPublicKey`.
- `testdata/task-signature.json`: `{ publicKey, task, signature }` generated once from a fixed test key; consumed by TS and Go tests.
- `TasksService.create(ctx, agentId, input: { type: AgentTask['type']; payload; resourceScope?; ttlSeconds?: default 600; maxRuntimeSeconds?: default 60; maxResponseBytes?: default 65536 }): Promise<AgentTask>`; publishes Redis `agent-tasks:<agentId>`.
- `POST /api/v1/agents/:id/diagnostics` (`agent.enroll`) → 202 `{ taskId }`; creates `inspect` with payload `{ target: 'agent_info' }`. `GET /api/v1/agents/:id/tasks` (`agent.view`) → last 20 with results.
- `GET /agent/v1/tasks?wait=0..25` (`@AgentRoute()`): returns `{ tasks: AgentTask[] }` of this agent's `queued` tasks with `expires_at > now` (marks them `delivered`); marks past-due queued tasks `expired`; if none, waits on the Redis channel up to `wait` seconds.
- `POST /agent/v1/tasks/:id/result` body `{ status: 'succeeded' | 'failed'; result?: object; error?: string }` → 204; another agent's task, unknown task, or already-finished → 404; body larger than `max_response_bytes` → 413.
- `POST /agent/v1/streams/:sessionId/chunks` body `StreamChunk` → 202; session of another agent, unknown, `closed`, or expired → 404; publishes Redis `stream:<sessionId>`. Sessions are created by `TasksService.openStream(ctx, taskId)` (used by M10 log tail; here only tests call it).

- [ ] **Step 1: Failing tests** — `canonical.test.ts`: key order independent; `{"b":1,"a":"é"}` → `{"a":"é","b":1}`; `1.5` throws; shared vector verifies. `task-signer.test.ts`: signature verifies with `publicKeyBase64`; flipping one payload byte fails (TC-03-11). `tasks.int.test.ts`: a queued task long-polled with `wait=25` returns within 1 s of creation; a task whose `expiresAt` passed while the agent was "offline" (fake clock +2 h) is never delivered and becomes `expired` (TC-03-09, Review Focus #3); a revoked agent polling → 401, nothing marked delivered; agent B posting a result for agent A's task → 404 (TC-03-10); 70 KB result on a 64 KB task → 413; chunk for a closed session → 404.
- [ ] **Step 2–4** → FAIL → implement → PASS.
- [ ] **Step 5: Handoff + commit** — `docs/handoffs/M5.5-tasks.md`.

### Task 7: Rotation and revocation (master M5.6)

**Files:**
- Create: `apps/api/src/modules/agents/rotate.controller.ts`
- Modify: `agents.controller.ts`, `agents.service.ts`, `enrollments.controller.ts`, OpenAPI
- Test: `apps/api/src/modules/agents/lifecycle.int.test.ts`

**Interfaces:**
- `POST /agent/v1/rotate` (`@AgentRoute()`) body `{ csrPem: string }` → 201 `{ certificatePem, chainPem, notAfter }`; the calling credential gets `superseded_at = now`; audit `agent.certificate_rotated`.
- `POST /api/v1/agents/:id/revoke` (`agent.revoke`) → 200 `{ status: 'revoked' }`; sets agent `revoked`, all credentials `revoked_at`, queued tasks `expired`; audit `agent.revoked`; publishes Redis `agent-revoked` with the fingerprints so every API process drops them from `AgentIdentityCache` immediately.
- `POST /api/v1/agent-enrollments/:id/revoke` (`agent.enroll`, resource `enrollment` resolved through the environment) → 200; later enrolls with that token → 401.

- [ ] **Step 1: Failing tests** — after rotation the old certificate works at +59 min and fails at +61 min; the new one works (TC-03-08); revocation → next control call 401 without waiting 30 s (pub/sub), audit row present; revoked enrollment token → 401 identical to unknown; analyst cannot revoke (404).
- [ ] **Step 2–4** → FAIL → implement → PASS.
- [ ] **Step 5: Handoff + commit** — `docs/handoffs/M5.6-rotation-revocation.md`.

### Task 8: Go control client and the M5 exit gate

**Files:**
- Create: `agents/host-agent-go/{go.mod,internal/control/{client.go,keys.go,canonical.go,tasks.go},internal/control/*_test.go}`, `tests/agent-e2e/control.e2e.test.ts`
- Modify: `go.work` (`./agents/host-agent-go`), `package.json` `test:go` and `vet:go` (+`./agents/host-agent-go/...`), `scripts/go.sh` (optional `GO_DOCKER_NETWORK` to attach the container to a Compose network)

**Interfaces:**
- Module `pcp.local/hostagent`, Go 1.23, standard library only.
- `keys.go`: `GenerateIdentity(dir string) (*Identity, error)` writes `agent.key` (P-256, PKCS#8 PEM, mode 0600) and `x25519.key` (mode 0600); `(*Identity) CSR(agentHint string) (string, error)`; `X25519PublicKeyBase64() string`.
- `client.go`: `New(controlURL string, tls *tls.Config, httpClient *http.Client) *Client`; `Enroll(ctx, token string, id *Identity, host HostInfo) (*EnrollResponse, error)`; `Heartbeat(ctx, hb Heartbeat) (accepted bool, err error)`; `PollTasks(ctx, wait time.Duration) ([]Task, error)` verifying every task's Ed25519 signature over `canonicalJSON` (tasks failing verification are dropped and reported via `ErrBadSignature` count); `PostResult(ctx, taskID string, r TaskResult) error`; `Rotate(ctx, id *Identity) (*RotateResponse, error)`. Types come from `packages/agent-protocol/go`.
- `canonical.go`: `canonicalJSON(v any) ([]byte, error)` with the same rules as Task 6.

- [ ] **Step 1: Failing tests** — `canonical_test.go`: the shared vector from `packages/agent-protocol/testdata/task-signature.json` verifies (Review Focus #4); `keys_test.go`: key files mode 0600, CSR parses as P-256; `client_test.go` against `httptest.NewTLSServer`: enroll → heartbeat → poll returns a signed task → result posted; a tampered task is dropped. `tests/agent-e2e/control.e2e.test.ts` (exit gate): starts the Compose stack with `CADDY_CONFIG=Caddyfile.local` and dev PKI, creates an enrollment through the user API, runs `scripts/go.sh test ./agents/host-agent-go/internal/control -run TestLiveControlFlow` on the Compose `edge` network with `PCP_CONTROL_URL=https://agent.localhost` (resolving to Caddy) and `PCP_ENROLL_TOKEN`; the Go test enrolls, heartbeats, receives a diagnostics task, answers it, rotates, and then observes 401 after the TS side revokes it.
- [ ] **Step 2–4** → FAIL → implement → PASS.
- [ ] **Step 5: Handoff + commit** — `docs/handoffs/M5-control-client.md`.

### Task 9: Fleet UI and the "Add server" flow (master M5.7)

**Files:**
- Create: `apps/web/app/(app)/orgs/[orgId]/products/[productId]/agents/{page.tsx,[agentId]/page.tsx}`, `apps/web/components/agents/{add-server-dialog,fleet-table,agent-status-badge,install-command}.tsx`
- Modify: `apps/web/lib/nav.ts` (Agents enabled), `apps/web/lib/setup-steps.ts` (servers step `todo` with `href` to Agents, `done` when any agent exists — `buildSetupSteps` gains `agents: number`), product page (passes agent count), `packages/api-client` (regenerate), `tests/e2e/agents.spec.ts`
- Test: component tests next to each component; `lib/setup-steps.test.ts`, `lib/nav.test.ts` updates

**Interfaces / behavior:**
- Agents page: empty state "No servers yet" + "Add server" button (needs `agent.enroll`); table columns Hostname, Environment, Status (Active / Degraded / Revoked, plus "Stale" badge), Version, Last seen (relative), with a "Duplicate machine ID" warning icon.
- Add server dialog: environment select (required; link to create one when none), "How many servers?" (1–1000 → `maxUses`), "Expires in" (1 h default, 24 h max) → shows the install command in a copy box with "Shown once. Copy it now." and the agent-type note; then "Waiting for servers…" polling `GET /api/v1/products/:productId/agents` every 3 s until an agent created after the dialog opened appears, then "Connected: <hostname>".
- Agent detail: identity, environment, status, certificate expiry, recent heartbeats, "Run diagnostics" (shows the task and its result when it arrives), "Revoke" with a confirmation dialog naming the hostname.

- [ ] **Step 1: Failing tests** — `setup-steps.test.ts`: servers step `todo` with href `/orgs/o1/products/p1/agents` when `agents: 0`, `done` when 1; nav: Agents has an href, others keep `milestone`; `install-command.test.tsx`: the copy button copies the exact command, and the token is not rendered after the dialog closes and reopens; `agent-status-badge.test.tsx`: degraded/stale labels. `tests/e2e/agents.spec.ts`: create enrollment (command shown once) → "Waiting for servers…" → a simulated agent (Node `https` client with a CSR from `@peculiar/x509`, through Caddy local TLS) enrolls and heartbeats → row shows Active → Revoke → status Revoked.
- [ ] **Step 2–4** → FAIL → implement → PASS.
- [ ] **Step 5: Handoff + commit** — `docs/handoffs/M5.7-fleet-ui.md`.

### Task 10: Compose wiring, local TLS, docs

**Files:**
- Modify: `.env.example` (agent variables documented), `tests/smoke/compose.smoke.test.ts`, `docs/workbooks/WB-03-agent-enrollment-identity-fleet.md` (§7 routes match, §12 ticks), `docs/handoffs/README.md`, `README.md` (local agent testing: `pnpm --filter @pcp/api agent:pki --out .pki`, `CADDY_CONFIG=Caddyfile.local`)

- [ ] **Step 1: Failing test** — smoke: with `Caddyfile.local` and generated PKI, `POST https://agent.localhost/agent/v1/heartbeat` without a client certificate → 401 from the API; `POST /agent/v1/enroll` with a bad token → 401 `invalid_enrollment_token`; in `Caddyfile.bootstrap`, `/agent/*` still answers 503.
- [ ] **Step 2–4** → FAIL → implement → PASS; full pipeline, smoke, e2e green.
- [ ] **Step 5: Handoff + commit** — `docs/handoffs/M5-compose.md`; M5 execution log after the final review.
