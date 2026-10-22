# M6a Host Metrics Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A customer runs the install command on a Linux VPS, and within 60 seconds the dashboard's Infrastructure page shows that host's CPU, memory, disk, and network. No inbound ports are opened.

**Architecture:** The installer (served by the platform) downloads two checksummed binaries: `pcp-agentctl` (the M5 control loop) and `pcp-otelcol` (an OpenTelemetry Collector built with `ocb`). The agent runs as the unprivileged `pcp-agent` systemd service. `pcp-agentctl run` writes the collector configuration and supervises the collector. The collector scrapes `hostmetrics` and sends Prometheus remote_write over mTLS to `ingest.<domain>`. The Go ingest gateway authenticates the agent by certificate fingerprint, overwrites the tenant labels, enforces limits, and forwards to VictoriaMetrics. The API's telemetry-query module reads VictoriaMetrics with enforced tenant and product filters, and the web app charts the results.

**Tech Stack:** Go 1.23 (gateway, agentctl; `google.golang.org/protobuf/encoding/protowire`, `github.com/golang/snappy`), OpenTelemetry Collector Builder v0.162.0 (Go 1.26 build image), VictoriaMetrics v1.126.0, NestJS 11, Next.js 15 + Recharts, Caddy 2 `file_server`, systemd.

**Spec:** `AI_Product_Control_Plane_Architecture_and_Flows.md` §8.5–§8.7, §11, §16.2, §17; master plan M6 (M6.1, M6.2, M6.5, M6.6, M6.7, M6.8), D12, D15, D16, D22, §3; WB-04, WB-05.

**Deferred to M6b:** OpAMP server and supervisor (M6.4), `pcpcontrol` extension and discovery (M6.3), OTLP logs and traces, live boost, the full D22 OS matrix, release size/RSS budget checks.

## Global Constraints

- Telemetry uses remote_write in M6a (OTLP endpoints answer 501 until M6b/M10).
- The gateway overwrites `tenant_id`, `product_id`, `environment_id`, `agent_id` on every series; agents can never choose them.
- Limits: per agent 20,000 active series/hour and 10,000 samples/s; per tenant 200,000 active series/hour; max request 10 MB decompressed; samples more than 1 h in the future rejected.
- Over-limit new series → 429 with `Retry-After`; existing series continue.
- VictoriaMetrics stays on the internal network; every read goes through the query module (timeout 30 s, ≤ 1,000 series, ≤ 11,000 points per series, ≤ 400 days).
- Missing data is shown as missing, never as zero.
- The agent runs as `pcp-agent`, outbound only; no Docker socket, no root mounts; collector has `memory_limiter`.
- Binaries are verified against SHA-256 checksums before install.

## Review Focus

1. **An agent sends `tenant_id="other-org"` labels.** Expected: stored series carry the agent's real tenant. Test in Task 2.
2. **The same remote_write batch is retried 3 times after a reconnect.** Expected: sample counts in VictoriaMetrics stay the same (dedup). Test in Task 2.
3. **A product-scoped analyst queries another product's host.** Expected: 404 for the host; PromQL results never include other products' series. Test in Task 3.
4. **The agent stops.** Expected: charts show a gap and a "No data since …" banner, not a flat zero. Test in Task 6.
5. **Installer re-run on an enrolled host.** Expected: it upgrades binaries and restarts without re-enrolling; `--force` re-enrolls. Test in Task 5.

---

### Task 1: Internal agent lookup for the gateway

**Files:**
- Create: `apps/api/src/modules/agents/internal.controller.ts`, `apps/api/src/common/internal.guard.ts`
- Modify: `apps/api/src/common/decorators.ts` (`@Internal()`), `apps/api/src/config.ts` (`INTERNAL_TOKEN`), `compose.yaml`, `.env.example`
- Test: `apps/api/src/modules/agents/internal.int.test.ts`

**Interfaces:**
- `GET /internal/agents/by-fingerprint/:fp` with header `X-Internal-Token: <INTERNAL_TOKEN>` → 200 `{ agentId, organizationId, productId, environmentId }` for a currently valid credential (same rules as `AgentIdentityCache.valid`), else 404. Missing/wrong token → 401. `INTERNAL_TOKEN` absent → route 404.
- `@Internal()` implies `@Public()`; tenant matrix requires `/internal/` routes to carry it. Caddy never routes `/internal/*` (already true).

- [ ] Step 1 failing tests (valid → 200 with tenant fields; revoked/expired → 404; wrong token → 401; token compared in constant time) → Step 2 FAIL → Step 3 implement → Step 4 PASS → Step 5 handoff `M6.5-internal-lookup.md` + commit.

### Task 2: Ingest gateway (master M6.5)

**Files:**
- Create: `apps/ingest-gateway/{auth.go,remotewrite.go,limits.go,forward.go,server.go}` and tests beside them
- Modify: `apps/ingest-gateway/{main.go,go.mod}`, `compose.yaml` (gateway env: `API_INTERNAL_URL`, `INTERNAL_TOKEN`, `VM_WRITE_URL`, `TRUSTED_PROXY_ADDRESSES`)

**Interfaces:**
- `POST /prometheus/api/v1/write` (snappy-compressed protobuf `WriteRequest`): fingerprint from `X-Client-Cert-Fingerprint` trusted only from `TRUSTED_PROXY_ADDRESSES` (socket peer); identity via Task 1 (cached 30 s); 401 otherwise.
- Every series: remove any `tenant_id`, `product_id`, `environment_id`, `agent_id` labels, then add the agent's values; samples > now+1h dropped and counted (400 if a whole request is in the future).
- Limits (`limits.go`): `SeriesLimiter` hourly set keyed `agent` (20,000) and `tenant` (200,000), new series beyond → whole request 429 `Retry-After: 60` but requests containing only known series pass; `RateLimiter` 10,000 samples/s per agent (token bucket, burst 10 s) → 429 with `Retry-After`.
- Body > 10 MB decompressed → 413.
- Forward re-encoded request to `VM_WRITE_URL` (`http://victoriametrics:8428/api/v1/write?extra_label=tenant_id=<org>`), propagate 5xx as 503 so the collector retries.
- `POST /otlp/v1/{metrics,logs,traces}` → 501.

- [ ] Step 1 failing tests: forged `tenant_id="B"` rewritten to A (Review Focus #1, TC-04-02); untrusted peer → 401; series limit: 20,000 known pass, new rejected 429, known still accepted (TC-04-03); rate limit; future samples; 413; forward URL carries `extra_label`; integration test with a real VictoriaMetrics container (`testcontainers-go` is not used — the test starts `victoriametrics/victoria-metrics:v1.126.0` via `docker run` only when `PCP_VM_URL` is set by the harness) proves replaying a batch 3× keeps `count_over_time` unchanged (Review Focus #2, TC-04-04).
- [ ] Step 2–4 → FAIL → implement → PASS. Step 5 handoff `M6.5-ingest-gateway.md` + commit.

### Task 3: Telemetry query module (master M6.6)

**Files:**
- Create: `apps/api/src/modules/telemetry/{telemetry.module,query.service,limits,host-metrics,telemetry.controller}.ts`
- Modify: `apps/api/src/config.ts` (`VM_QUERY_URL`), OpenAPI, api-client
- Test: `apps/api/src/modules/telemetry/{limits.test.ts,query.int.test.ts}` (VictoriaMetrics container started in `test/global-setup.ts`)

**Interfaces:**
- `TelemetryQueryService.query(ctx, q: MetricQuery, scope: { productId: string; agentId?: string }): Promise<MetricResult>` → VictoriaMetrics `/api/v1/query_range` with `extra_label=tenant_id=<org>` and `extra_filters[]={product_id="<id>"}` (plus `agent_id` when given); timeout 30 s; step raised so `(end−start)/step ≤ 11,000`; > 1,000 series → 422 `too_many_series`; range > 400 d → 400; part of the range older than 15 d → `completeness: 'partial'` with `gaps: [{ from, to, reason: 'retention' }]`.
- `GET /api/v1/agents/:id/metrics?range=15m|1h|6h|24h|7d` (`telemetry.query`, resource `agent`) → `{ range, step, series: { cpu: Point[], memory: Point[], disk: Array<{ mountpoint, points }>, networkIn: Point[], networkOut: Point[] }, lastSampleAt }` with `Point = [epochSeconds, number | null]` (nulls for gaps). PromQL is built server-side from fixed templates (no user PromQL in M6a).
- `GET /api/v1/products/:productId/infrastructure` (`telemetry.query`) → hosts with current `cpuPercent`, `memoryPercent`, `diskPercent` (max over mountpoints), `lastSampleAt`, plus agent status.

- [ ] Step 1 failing tests: tenant A never sees tenant B series (TC-04-06); product-scoped analyst → other product host 404 and filters applied (Review Focus #3); 30-day range at 15 s raised to ≤ 11,000 points (TC-04-07); range beyond retention → partial with gap (TC-04-08); gaps are null, not 0.
- [ ] Step 2–4 → FAIL → implement → PASS. Step 5 handoff `M6.6-telemetry-query.md` + commit.

### Task 4: Collector distribution and agent supervision (master M6.1, M6.2)

**Files:**
- Create: `agents/host-agent-go/collector/builder-config.yaml`, `agents/host-agent-go/internal/collector/{config.go,supervise.go}` + tests, `agents/release/Dockerfile` (builds `pcp-agentctl` and `pcp-otelcol` for linux/amd64 and linux/arm64, tarballs `pcp-agent-<version>-linux-<arch>.tar.gz`, `SHA256SUMS`)
- Modify: `agents/host-agent-go/cmd/pcp-agentctl/main.go` (`run` starts and supervises the collector)

**Interfaces:**
- `builder-config.yaml`: dist `pcp-otelcol`, otelcol v0.162.0; receivers `hostmetrics`, `prometheus`; processors `memory_limiter`, `batch`, `resourcedetection`; exporters `prometheusremotewrite`; extensions `file_storage`, `health_check`.
- `collector.Config(in Input) ([]byte, error)` with `Input{ IngestURL, CertFile, KeyFile, CAFile?, ServerName?, StorageDir, ScrapeInterval (30 s) }` → YAML: hostmetrics scrapers `cpu`, `memory`, `filesystem`, `network`, `load`, `disk`; `memory_limiter` 100 MiB limit; remote_write with mTLS, WAL in `StorageDir`, retry on 429/5xx; resource attributes become labels; listens only on `127.0.0.1` (health check).
- `collector.Supervise(ctx, binary, configPath, logf)`: restarts with exponential backoff (1 s → 60 s), stops on context cancel.
- `pcp-agentctl run`: writes `collector.yaml` (0600) on start and after rotation, then supervises `pcp-otelcol`.

- [ ] Step 1 failing tests: generated config parses as YAML and contains the mTLS paths, `memory_limiter`, no `0.0.0.0` listener; supervisor restarts a crashing fake binary with backoff and stops on cancel; `docker build -f agents/release/Dockerfile` produces both tarballs and a valid `SHA256SUMS`; `pcp-otelcol validate --config` accepts the generated config.
- [ ] Step 2–4 → FAIL → implement → PASS. Step 5 handoff `M6.1-collector-dist.md` + commit.

### Task 5: Installer and downloads (master M6.7)

**Files:**
- Create: `agents/host-agent-go/installer/install.sh`, `agents/host-agent-go/packaging/systemd/pcp-agent.service`, `infrastructure/downloads/` (image serving `install.sh`, tarballs, `SHA256SUMS`)
- Modify: `compose.yaml` (`downloads` service), Caddyfiles (`/install.sh` and `/downloads/*` → `downloads`), `tests/agent-e2e/install.e2e.test.ts`

**Interfaces:**
- `install.sh --token T --control-url URL [--environment-label NAME] [--force] [--uninstall] [--download-url BASE]` (BASE defaults to the origin it was fetched from, written into the script at serve time): requires root and systemd; detects `amd64`/`arm64`; downloads the tarball and `SHA256SUMS`, verifies with `sha256sum -c` (mismatch → abort, nothing installed); creates system user `pcp-agent`, `/etc/pcp-agent` (0750), `/var/lib/pcp-agent` (0700, owned by `pcp-agent`), binaries in `/usr/local/bin`; runs `pcp-agentctl enroll` as `pcp-agent` unless already enrolled (re-run upgrades; `--force` re-enrolls); installs and starts `pcp-agent.service` (`User=pcp-agent`, `NoNewPrivileges=yes`, `ProtectSystem=strict`, `ReadWritePaths=/var/lib/pcp-agent`, `Restart=always`); `--uninstall` stops the unit and removes user, unit, binaries, and directories.

- [ ] Step 1 failing tests (`install.e2e.test.ts`, systemd container `ubuntu:24.04` with systemd as PID 1 on the Compose edge network, using `Caddyfile.local`): install → agent visible and `system_cpu_*` series queryable within 60 s (TC-04-01); `ss -ltn` shows no new non-loopback listener; re-run keeps the same agent ID (Review Focus #5); tampered tarball → non-zero exit and no unit; `--uninstall` removes everything.
- [ ] Step 2–4 → FAIL → implement → PASS. Step 5 handoff `M6.7-installer.md` + commit.

### Task 6: Infrastructure UI (master M6.8)

**Files:**
- Create: `apps/web/app/(app)/orgs/[orgId]/products/[productId]/infrastructure/{page.tsx,[agentId]/page.tsx}`, `apps/web/components/telemetry/{metric-chart,stale-banner,usage-bar}.tsx`
- Modify: `apps/web/lib/nav.ts` (Infrastructure enabled), `apps/web/package.json` (`recharts`), agent detail page (link to metrics), `tests/e2e/agents.spec.ts` or new `infrastructure.spec.ts`

**Behavior:**
- Infrastructure page: one row per host with CPU, memory, disk usage bars and status; link to host metrics.
- Host page: range selector (15 m, 1 h, 6 h, 24 h, 7 d); line charts CPU %, memory %, network in/out (bytes/s), disk % per mountpoint; `null` points render as gaps (`connectNulls={false}`); "No data since <time>" banner when `lastSampleAt` is older than 2 minutes, and "Partial range" note when the API reports retention gaps.

- [ ] Step 1 failing tests: `metric-chart` renders gaps for nulls and never draws 0 for missing (Review Focus #4, TC-04-13); `stale-banner` thresholds; `usage-bar` labels; nav enables Infrastructure; Playwright: after the agent journey's install (Task 5 harness), the host page shows a CPU chart with data.
- [ ] Step 2–4 → FAIL → implement → PASS. Step 5 handoff `M6.8-infrastructure-ui.md` + commit.

### Task 7: Exit gate, docs, deployment runbook

**Files:**
- Create: `docs/runbooks/deploy-control-plane.md` (public VPS + domain: DNS records, `.env`, `Caddyfile.production`, agent PKI, firewall, first admin, adding servers)
- Modify: setup checklist (servers step mentions metrics), `docs/workbooks/WB-04…`, `WB-05…` checklists, board, README

- [ ] Step 1: full pipeline (unit, Go, smoke, Playwright, agent e2e including install) green.
- [ ] Step 2: handoff `M6a-execution-log.md`; board.
