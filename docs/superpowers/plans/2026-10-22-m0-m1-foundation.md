# M0 + M1 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver milestones M0 (contracts and decisions) and M1 (monorepo, CI, Compose skeleton) of the master plan: a working pnpm/Turborepo monorepo with shared contracts, ADRs, threat model, OpenAPI draft, health-checked service skeletons, a Compose stack that runs in both deployment modes, and CI.

**Architecture:** pnpm workspace + Turborepo. TypeScript packages are ESM (`"type": "module"`, `NodeNext`). NestJS 11 on Fastify for the API, a Node health server for the worker, Next.js 15 for the web app, Go 1.23 for `opamp-server` and `ingest-gateway`. Repository-level checks (ADRs, threat model, OpenAPI coverage, CI coverage) are `node:test` scripts under `scripts/__tests__/`.

**Tech Stack:** Node.js 22+ (local 24), pnpm 9.15.9 via corepack, Turborepo 2.5.8, TypeScript 5.9.3, Vitest 3.2.7, ESLint 9.39.5 + typescript-eslint 8.40.0, Prettier 3.6.2, Zod 3.25.76, Ajv 8.17.1, json-schema-to-typescript 15.0.4, yaml 2.8.x, NestJS 11.2.7, Fastify 5, Next.js 15.5.28, React 19.1.10, pg 8.16.x, ioredis 5.11.1, Go 1.23 (Docker `golang:1.23.12-alpine`), Spectral CLI 6.15.1, Docker Compose, Caddy 2.10, PostgreSQL 17, Redis 7.4, VictoriaMetrics/vmalert v1.126.0, actionlint 1.7.7.

**Spec:** `AI_Product_Control_Plane_Architecture_and_Flows.md` (v1.1) and master plan `docs/superpowers/plans/2026-10-21-ai-product-control-plane.md` (M0, M1, §2 decisions, §3 defaults, §4 contracts). Behavior references: `docs/workbooks/`.

## Global Constraints

- All master-plan Global Constraints apply.
- Tenant identity never appears in agent protocol messages (`EnrollRequest` etc. reject `organizationId`, `productId`, `environmentId`).
- PostgreSQL 5432, Redis 6379, VictoriaMetrics 8428, vmalert 8880 are never published to the host network.
- Only Caddy publishes ports: `${HTTP_PORT:-8080}:80`, `${HTTPS_PORT:-8443}:443`.
- Exact versions are pinned in `package.json` (no `^`/`~`) and `pnpm-lock.yaml` is committed.
- Every handoff document lives at `docs/handoffs/<task-id>-<slug>.md` and the board at `docs/handoffs/README.md` is updated in the same commit as the task.

## Review Focus

1. **Host already uses ports 5432/6379/8080.** Expected: smoke test asserts "not published" through Compose metadata, not by probing host ports, so a developer's local PostgreSQL never causes a false failure. Test in Task 7 (`storage ports are not published`).
2. **`.env` missing required secrets.** Expected: `docker compose config` fails fast with a clear message (`${VAR:?message}`), never starts with empty passwords. Test in Task 7 (`compose refuses to start without POSTGRES_PASSWORD`).
3. **Readiness when a dependency is down.** Expected: `/readyz` returns 503 naming the failing check while `/healthz` stays 200. Test in Task 6.
4. **Agent payload carrying tenant identifiers.** Expected: schema rejection. Test in Task 3.
5. **Spec route added without OpenAPI entry.** Expected: repository test fails naming the missing route. Test in Task 5.

---

### Task 1: Monorepo tooling (master M1.1)

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `eslint.config.mjs`, `.prettierrc.json`, `.prettierignore`, `.nvmrc`, `.editorconfig`, `README.md`
- Test: `scripts/__tests__/workspace.test.mjs`

**Interfaces:**
- Produces: root scripts `build`, `lint`, `typecheck`, `test` (Turborepo), `test:repo` (`node --test scripts/__tests__/`), `format:check`; workspace globs `apps/*`, `packages/*`, `packages/connectors/*`, `agents/*`, `tests`; `tsconfig.base.json` (strict, ES2022, NodeNext).

- [ ] **Step 1: Write the failing test** — `workspace.test.mjs` asserts: `package.json` has `packageManager: "pnpm@9.15.9"`, `engines.node: ">=22"`, no dependency version starting with `^` or `~`; `pnpm-workspace.yaml` lists the five globs; `turbo.json` defines tasks `build`, `lint`, `typecheck`, `test`; `tsconfig.base.json` has `strict: true` and `module: "NodeNext"`.
- [ ] **Step 2: Run it** — `node --test scripts/__tests__/` → Expected: FAIL (`ENOENT package.json`).
- [ ] **Step 3: Create the files** with the versions in Tech Stack; `turbo.json` `build.dependsOn: ["^build"]`, outputs `dist/**`, `.next/**` (excluding `.next/cache/**`).
- [ ] **Step 4: Run** — `node --test scripts/__tests__/` → PASS; `corepack pnpm install` → lockfile created; `corepack pnpm turbo run lint typecheck test` → exits 0 (no packages yet).
- [ ] **Step 5: Handoff + commit** — `docs/handoffs/M1.1-monorepo-tooling.md`, board `docs/handoffs/README.md`; `git commit -m "build: add monorepo tooling (M1.1)"`.

### Task 2: Architecture decision records (master M0.1)

**Files:**
- Create: `docs/adr/0000-template.md`, `docs/adr/0001-modular-monolith.md` … `docs/adr/0015-google-authorization.md`
- Test: `scripts/__tests__/adrs.test.mjs`

**Interfaces:**
- Produces: ADR numbering 0001–0015 exactly as master plan M0.1 lists; each ADR has `Status:` line and `## Context`, `## Decision`, `## Consequences`, `## References` sections.

- [ ] **Step 1: Write the failing test** — asserts 16 files exist (template + 15), names match `NNNN-slug.md`, each non-template ADR has a `Status: Proposed` or `Status: Accepted` line, the four sections, and at least one master-plan decision (`D\d+`) or spec section (`§\d+`) reference.
- [ ] **Step 2: Run** — `node --test scripts/__tests__/adrs.test.mjs` → FAIL (`docs/adr` missing).
- [ ] **Step 3: Write the ADRs** from master plan §2 decisions. Status `Proposed` (human acceptance by tech lead and security owner is the M0 exit gate).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Handoff + commit** — `docs/handoffs/M0.1-adrs.md`; `git commit -m "docs: add ADRs 0001-0015 (M0.1)"`.

### Task 3: Shared contracts and agent protocol (master M0.2)

**Files:**
- Create: `packages/shared-contracts/{package.json,tsconfig.json,tsconfig.build.json,vitest.config.ts}`, `packages/shared-contracts/src/{tenancy,connector,graph,packs,ai,secrets,index}.ts`
- Create: `packages/agent-protocol/{package.json,tsconfig.json,tsconfig.build.json,vitest.config.ts}`, `packages/agent-protocol/schemas/{enroll-request,enroll-response,heartbeat,agent-task,stream-chunk}.schema.json`, `packages/agent-protocol/scripts/generate.mjs`, `packages/agent-protocol/src/{validate,index}.ts`, generated `packages/agent-protocol/src/generated/types.ts`, `packages/agent-protocol/go/{go.mod,types.go}`
- Test: `packages/shared-contracts/src/contracts.test.ts`, `packages/agent-protocol/src/validate.test.ts`, `packages/agent-protocol/src/generate.test.ts`

**Interfaces:**
- Produces (`@pcp/shared-contracts`): constants `ROLES` (5), `PERMISSIONS` (master §4.1 list), `CONNECTOR_CAPABILITIES` (11, spec §9), `CONNECTION_STATUSES` (7), `CONNECTION_REASONS` (4), `ASSET_LIFECYCLES` (6), `RELATION_TYPES` (14), `VERIFICATION_STATES` (4), `IMPACT_CLASSES` (3), `TOOL_NAMES` (18); Zod schemas `connectorCapabilitySchema`, `observationSchema`, `relationTypeSchema`, `metricQuerySchema`, `evidenceSchema`, `packManifestSchema`; types `Role`, `Permission`, `TenantContext`, `ConnectorCapability`, `ConnectionStatus`, `ConnectionReason`, `Observation`, `DiscoveryPage`, `MetricQuery`, `MetricResult`, `AssetLifecycle`, `RelationType`, `VerificationState`, `ImpactClass`, `PackManifest`, `ToolName`, `Evidence`, `ToolResult<O>`, `EncryptedSecret`.
- Produces (`@pcp/agent-protocol`): `validateMessage(kind: MessageKind, data: unknown): { ok: true } | { ok: false; errors: string[] }` where `MessageKind = 'enroll-request' | 'enroll-response' | 'heartbeat' | 'agent-task' | 'stream-chunk'`; generated TS interfaces `EnrollRequest`, `EnrollResponse`, `Heartbeat`, `AgentTask`, `StreamChunk`; Go package `agentprotocol` (module `pcp.local/agentprotocol`) with the same structs.

- [ ] **Step 1: Write failing tests** —
  - `contracts.test.ts`: `connectorCapabilitySchema.safeParse('teleport').success === false`; `CONNECTOR_CAPABILITIES.length === 11`; observation with `confidence: 1.5` and `-0.1` rejected, `0.95` accepted; `relationTypeSchema` accepts `DEPLOYS`, rejects `FOO`; `RELATION_TYPES.length === 14`; `TOOL_NAMES` has 18 entries including `getApplicationMetrics`; a Redis pack manifest parses; `changeLevel: 3` rejected.
  - `validate.test.ts`: valid `EnrollRequest` → ok; same with `organizationId` → not ok; heartbeat without `sequence` → not ok; agent task with unknown `type` → not ok.
  - `generate.test.ts`: running `generate.mjs --check` exits 0 (generated TS and Go equal committed files).
- [ ] **Step 2: Run** — `corepack pnpm --filter @pcp/shared-contracts --filter @pcp/agent-protocol test` → FAIL (modules missing).
- [ ] **Step 3: Implement** contracts and schemas per master §4; JSON Schemas draft 2020-12 with `additionalProperties: false`; generator maps `string→string`, `integer→int64`, `number→float64`, `boolean→bool`, string arrays → `[]string`, objects with `additionalProperties` → `map[string]any`, nested objects → named structs, `json:"<name>,omitempty"` for optional fields.
- [ ] **Step 4: Run** tests → PASS; `scripts/go.sh vet ./packages/agent-protocol/go/...` → exit 0.
- [ ] **Step 5: Handoff + commit** — `docs/handoffs/M0.2-shared-contracts.md`; `git commit -m "feat(contracts): add shared contracts and agent protocol schemas (M0.2)"`.

### Task 4: Threat model and data classification (master M0.3)

**Files:**
- Create: `docs/security/threat-model.md`, `docs/security/data-classification.md`
- Test: `scripts/__tests__/threat-model.test.mjs`

**Interfaces:**
- Consumes: spec §18.1 threat table; master plan task headings `**M<n>.<k> …**`.
- Produces: one `### <threat>` section per spec §18.1 threat with an `Owning tasks:` line; data-class table with an `LLM eligible` column.

- [ ] **Step 1: Failing test** — parses spec §18.1 table rows; asserts each threat name appears as a `### ` heading in `threat-model.md`; each section's `Owning tasks:` IDs all exist in the master plan; `data-classification.md` lists every spec §11.1 data class.
- [ ] **Step 2: Run** → FAIL (file missing).
- [ ] **Step 3: Write** STRIDE per component and the data classification.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Handoff + commit** — `docs/handoffs/M0.3-threat-model.md`; `git commit -m "docs(security): add threat model and data classification (M0.3)"`.

### Task 5: OpenAPI v1 draft (master M0.4)

**Files:**
- Create: `docs/architecture/openapi-v1.yaml`, `.spectral.yaml`
- Test: `scripts/__tests__/openapi.test.mjs`
- Modify: `package.json` (devDependencies `@stoplight/spectral-cli@6.15.1`, `yaml`; script `lint:openapi`)

**Interfaces:**
- Consumes: spec §15 route blocks; workbook routes (WB-01, WB-03, WB-05, WB-10–WB-16).
- Produces: OpenAPI 3.1 document; security schemes `sessionCookie` (apiKey cookie `pcp_session`), `agentMtls` (mutualTLS), `webhookSignature` (apiKey header), `internalToken` (apiKey header `X-Internal-Token`).

- [ ] **Step 1: Failing test** — parses every `METHOD /path` line inside spec §15 code blocks; converts `:param` → `{param}`; asserts each exists in `openapi-v1.yaml`; asserts every operation has a `security` key (public ones use `[]`) and a unique `operationId`.
- [ ] **Step 2: Run** → FAIL (file missing).
- [ ] **Step 3: Write** the OpenAPI draft and Spectral ruleset (`extends: spectral:oas`, custom error rule `operation-security-declared`).
- [ ] **Step 4: Run** test → PASS; `corepack pnpm lint:openapi` → `No results with a severity of 'error'`.
- [ ] **Step 5: Handoff + commit** — `docs/handoffs/M0.4-openapi.md`; `git commit -m "docs(api): add OpenAPI v1 draft and lint (M0.4)"`.

### Task 6: Application skeletons (master M1.2)

**Files:**
- Create: `packages/health/` (`src/{checks,run-checks,index}.ts`, test `src/run-checks.test.ts`)
- Create: `apps/api/` (`src/{main,app.module}.ts`, `src/health/health.controller.ts`, test `src/health/health.controller.test.ts`, `vitest.config.ts` with `unplugin-swc`)
- Create: `apps/worker/` (`src/{main,health-server}.ts`, test `src/health-server.test.ts`)
- Create: `apps/web/` (`app/{layout,page}.tsx`, `app/healthz/route.ts`, test `app/healthz/route.test.ts`, `next.config.mjs` with `output: 'standalone'`)
- Create: `apps/opamp-server/{go.mod,main.go,health.go,health_test.go}`, `apps/ingest-gateway/{go.mod,main.go,health.go,health_test.go}`, `go.work`, `scripts/go.sh`

**Interfaces:**
- Produces (`@pcp/health`): `interface ReadinessCheck { name: string; check(): Promise<void> }`; `runChecks(checks: ReadinessCheck[], timeoutMs?: number): Promise<{ ok: boolean; results: Array<{ name: string; ok: boolean; error?: string }> }>` (default timeout 2,000 ms); `postgresCheck(url: string): ReadinessCheck`; `redisCheck(url: string): ReadinessCheck`.
- Produces (api): `GET /healthz` → 200 `{ status: 'ok', service: 'api', deploymentMode }`; `GET /readyz` → 200 or 503 `{ status: 'ready' | 'not_ready', checks }`; port `API_PORT` (default 3000).
- Produces (worker): HTTP health on `WORKER_HEALTH_PORT` (default 3002), same `/healthz` and `/readyz` contract.
- Produces (web): `GET /healthz` → 200 `{ status: 'ok', service: 'web' }`; port 3001.
- Produces (Go): `GET /healthz` → 200 `{"status":"ok","service":"<name>"}`; subcommand `healthcheck` probes `http://127.0.0.1:<port>/healthz` and exits 0/1; ports `OPAMP_PORT` 4320, `INGEST_PORT` 4318.

- [ ] **Step 1: Failing tests** — `runChecks` reports a throwing check as `ok:false` with its message and a hanging check as timed out; api `/readyz` returns 503 naming `postgres` when that check throws while `/healthz` stays 200 and includes `deploymentMode`; worker server same contract; web route returns 200 JSON; Go `TestHealthz` 200 body and `TestProbe` failure on closed port.
- [ ] **Step 2: Run** — `corepack pnpm turbo run test --filter @pcp/health --filter @pcp/api --filter @pcp/worker --filter @pcp/web` and `scripts/go.sh test ./apps/...` → FAIL.
- [ ] **Step 3: Implement** minimal services.
- [ ] **Step 4: Run** → PASS; `corepack pnpm turbo run build lint typecheck` → exit 0.
- [ ] **Step 5: Handoff + commit** — `docs/handoffs/M1.2-app-skeletons.md`; `git commit -m "feat: add api, worker, web, opamp-server, ingest-gateway skeletons (M1.2)"`.

### Task 7: Compose stack and Caddy (master M1.3)

**Files:**
- Create: `compose.yaml`, `.env.example`, `apps/{api,worker,web}/Dockerfile`, `apps/{opamp-server,ingest-gateway}/Dockerfile`, `.dockerignore`, `infrastructure/caddy/Caddyfile.bootstrap`, `infrastructure/caddy/Caddyfile.production`, `infrastructure/telemetry/rules/platform.yaml`
- Test: `tests/package.json`, `tests/smoke/compose.smoke.test.ts`, `tests/smoke/caddy.test.ts`, `tests/vitest.config.ts`

**Interfaces:**
- Consumes: Task 6 health contracts.
- Produces: Compose services `caddy`, `web`, `api`, `worker`, `postgres`, `redis`, `victoriametrics`, `vmalert`, `opamp-server`, `ingest-gateway`; networks `edge`, `internal` (`internal: true`); env `DEPLOYMENT_MODE` (`managed` | `self_hosted`), `BOOTSTRAP_MODE` (`private_http` | `off`), `CADDY_CONFIG`.

- [ ] **Step 1: Failing tests** —
  - `compose refuses to start without POSTGRES_PASSWORD`: `docker compose config` with empty env exits non-zero and stderr names `POSTGRES_PASSWORD`.
  - `storage ports are not published`: `docker compose config --format json` has no `ports` on `postgres`, `redis`, `victoriametrics`, `vmalert`, `api`, `worker`, `web`, `opamp-server`, `ingest-gateway`; only `caddy` publishes.
  - `stack becomes healthy in <mode>` for `managed` and `self_hosted`: `docker compose up -d --build --wait --wait-timeout 300` succeeds; `GET http://localhost:${HTTP_PORT}/healthz` through Caddy returns api JSON with matching `deploymentMode`; `GET /` returns web 200.
  - `caddy configs validate`: `caddy validate` passes for both Caddyfiles.
- [ ] **Step 2: Run** — `corepack pnpm --filter @pcp/tests test:smoke` → FAIL (`compose.yaml` missing).
- [ ] **Step 3: Implement** Compose, Dockerfiles, Caddyfiles, env template.
- [ ] **Step 4: Run** → PASS (both modes).
- [ ] **Step 5: Handoff + commit** — `docs/handoffs/M1.3-compose-caddy.md`; `git commit -m "build: add compose stack, dockerfiles, caddy (M1.3)"`.

### Task 8: CI pipeline (master M1.4)

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/nightly-live.yml`
- Test: `scripts/__tests__/ci.test.mjs`

**Interfaces:**
- Consumes: root scripts (Task 1), `lint:openapi` (Task 5), `scripts/go.sh` equivalents via `actions/setup-go`, `test:smoke` (Task 7).
- Produces: CI jobs `node` (install, lint, typecheck, unit, repo tests), `go` (vet, test), `openapi`, `smoke` (matrix `managed`, `self_hosted`), `sbom`, `osv-scan`, `secret-scan`.

- [ ] **Step 1: Failing test** — asserts `ci.yml` exists, triggers on `pull_request` and `push` to `main`, has the seven jobs, `smoke` matrix includes both modes, every `uses:` is pinned to a version tag, and `nightly-live.yml` has a `schedule`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Write** workflows.
- [ ] **Step 4: Run** test → PASS; `docker run --rm -v "$PWD":/repo -w /repo rhysd/actionlint:1.7.7 -color=never` → no output, exit 0.
- [ ] **Step 5: Handoff + commit** — `docs/handoffs/M1.4-ci.md`; update master plan status, workbook checklists (WB-17); `git commit -m "ci: add CI and nightly workflows (M1.4)"`.
