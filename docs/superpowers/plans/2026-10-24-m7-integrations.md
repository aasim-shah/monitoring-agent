# M7 Cloud Integrations and Webhooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin connects the following, sees what each discovered, and chooses what belongs to the product:
- **Cloudflare**, with a scoped API token: zones, DNS records, certificates.
- **GitHub**, with a fine-grained token: repositories, workflows, deployments, releases.
- **A Prometheus**, which is queried and never copied.
- **Grafana**: dashboards as links.

Then:
- **Webhooks:** signed GitHub and Cloudflare webhooks become change events (deployments, failed workflows, releases, DNS changes), deduplicated and audited.
- **Everywhere change events appear:** the AI assistant's `getDeployments`, the daily report's "Recent deployments", and the incident correlation window.
- **M16 actions:** Cloudflare cache purge and GitHub workflow dispatch execute through the M16 approval flow.

**Architecture:**
- **Connectors** are `packages/connectors/{cloudflare,github,prometheus,grafana}`. Each implements the M4 `Connector` contract over the SSRF-guarded HTTP client: `validate`, `discover` (observations), `health`, and optionally `ingestEvent`, `collect`, and `executeAction`.
- **The worker's discover job stores observations** in a new `connection_inventory` table (replacing the previous inventory) instead of only counting them.
- **Asset discovery** (`DiscoveryService.run`, M9) turns inventory items scoped to the product into assets:
  - Cloudflare zone → `domain`, with DNS records as attributes
  - GitHub repository → `repository`
  - Prometheus target → `host`, with weak identity matched by IP or hostname, and its job → `service`
- **Webhooks** arrive at `POST /webhooks/:provider/:connectionId` (public, only over HTTPS through Caddy).
  1. Verify the provider signature: GitHub `X-Hub-Signature-256`, the Cloudflare notification secret.
  2. Deduplicate on `(provider, delivery_id)`, kept 7 days.
  3. The connection must be `connected` or `degraded`. An unknown connection and a bad signature give the same 401.
  4. `connector.ingestEvent` normalizes the event into `change_events` rows.
  5. Only delivery metadata is stored.

**Tech Stack:** connector SDK (M4), Prisma 6 and RLS, NestJS 11 (raw body for signatures), `node:crypto` HMAC, Next.js 15, Playwright.

**Spec:** spec §7 table, §7.1, §7.7, §11.4 (Mode A), §13.4; master plan M7.1–M7.5; `docs/workbooks/WB-06-cloud-integrations-webhooks.md`.

**Deviation (user decision 2026-10-24):** GitHub connects with a **fine-grained personal access token** (read-only: Metadata, Actions, Deployments, Contents; plus Actions write only for workflow dispatch) and a webhook secret, instead of a GitHub App, so no app registration is needed. The App flow (UC-06-04) is deferred; the connector keeps one client wrapper, so adding App auth later changes only the authentication step.

**Deferred:**
- Cloudflare traffic and security analytics (GraphQL) metrics, and Grafana snapshot rendering.
- Nightly live tests (TC-06-09), which need the user's real tokens. Webhook and connector contracts run on recorded fixtures.

## Global Constraints

- **Tokens:** stored only through the M4 credentials store (encrypted, never returned). Cloudflare is read-only unless purge is enabled (BR-06-01). GitHub never calls a secrets endpoint; the client wrapper allowlists paths (BR-06-02, TC-06-05).
- **HTTP:** the connector HTTP client with a 10 s timeout, a 5 MB response cap, and 3 retries on 429/5xx honoring `Retry-After`. 429 becomes `rate_limited`; 401/403 become `reauthorization_required`/`permission_denied` with the missing permission named (UC-06-11).
- **Prometheus Mode A:** never copied (BR-06-03). Queries obey the hosted limits (`planRange`: at most 31 days, 11,000 points, 500 series), and an over-limit query is refused before it is sent (TC-06-07).
- **Grafana:** link target only (BR-06-04).
- **Webhooks (BR-06-05):**
  - signature check, plus a 5 min timestamp check where the provider sends one
  - idempotency for 7 days
  - unknown connection, bad signature, and a disconnected connection all return the same 401 body; bad signatures are audited
  - payloads are not stored
  - at most 1 MB per body
- **Provider content** is untrusted data: never instructions, and only passed to the AI as data (BR-06-06).
- **Permissions:**

  | Action | Permission |
  |---|---|
  | View connections | `connection.view` |
  | Connect, scope, delete | `connection.configure` (existing M4 routes) |

## Review Focus

1. **A forged webhook:** a correct delivery ID with a wrong signature, a valid signature for another connection, or a replay after 7 days. Expected: 401, audited, no change event. A replay within 7 days returns 200 with no new row. Task 2.
2. **A token with fewer permissions than needed:** no DNS read, or a repository the token cannot see. Expected: `permission_denied` naming the permission, other discovery still works, and no crash. Tasks 3 and 4.
3. **A Prometheus target label with a private IP or a huge `instance` list.** Expected: weak-identity hosts only (never merged without review), and discovery capped at 1,000 targets. Task 5.
4. **A GitHub repository secret path requested through any code path.** Expected: refused by the wrapper. Task 4.
5. **A webhook for a connection in another organization**, sent to this organization's URL. Expected: the signature is checked with that connection's own secret only, so it fails with 401. Task 2.

---

### Task 1: Schema (migration 0012) and storing discoveries

**Tables:**

| Table | Columns | Constraints |
|---|---|---|
| `webhook_deliveries` | `organization_id`, `connection_id`, `provider`, `delivery_id`, `event_type`, `received_at`, `result` (`processed`, `duplicate`, `rejected`, or `ignored`), `detail` | unique `(provider, delivery_id)` |
| `change_events` | `organization_id`, `connection_id`, `product_id` (nullable), `provider`, `kind` (`deployment`, `deployment_failed`, `workflow_failed`, `release`, `dns_change`, `security_event`, or `push`), `title`, `url`, `actor`, `occurred_at`, `attributes jsonb`, `external_id` | unique `(connection_id, kind, external_id)` |
| `connection_inventory` | `organization_id`, `connection_id`, `resource_type`, `external_id`, `name`, `attributes jsonb`, `observed_at` | unique `(connection_id, resource_type, external_id)` |

- All three have forced RLS.
- **Processor:** the `connection-discover` job replaces the connection's inventory with the observations returned. It caps at 5,000 items and redacts with `redactAttributes`.

- [ ] Failing tests:
  - RLS on all three tables
  - the unique keys
  - a discover job with 3 observations stores 3 inventory rows and replaces them on the next run (jobs int test with the mock connector)

  Implement, pass, commit.

### Task 2: Webhook ingestion framework

**Files:** `apps/api/src/modules/webhooks/{webhooks.module.ts,webhooks.controller.ts,webhooks.service.ts,verifiers.ts,webhooks.int.test.ts}`; raw-body capture for `/webhooks/*` in `main.ts` and the test app.

**Interfaces:**
- **`verifyGithub(rawBody, header, secret)`:** HMAC-SHA256, compared in constant time.
- **`verifyCloudflare(header, secret)`:** the `cf-webhook-auth` shared secret, compared in constant time.
- **The connection's credentials** hold `webhookSecret`.
- **`POST /webhooks/:provider/:connectionId`:**
  1. 401 `{ code: 'invalid_signature' }` for any of an unknown connection, a provider mismatch, a disconnected status, or a bad signature. A bad signature is audited as `webhook.rejected`.
  2. A duplicate delivery ID returns 200 `{ duplicate: true }`.
  3. Otherwise `connector.ingestEvent(event)` returns change events, which are upserted, and the delivery row is recorded. Returns 202.
  4. Events the connector ignores are recorded `ignored`.
- **The delivery ID** is GitHub's `X-GitHub-Delivery`, or for Cloudflare the payload `id`, else a SHA-256 of the body.

- [ ] Failing tests (with a mock connector `ingestEvent`):
  - TC-06-03: a signed event gives one change event; the replay still gives one and returns duplicate
  - TC-06-04: a bad signature gives 401 plus an audit row; an unknown connection gives an identical 401 body
  - a disconnected connection gives 401
  - a signature made with another connection's secret gives 401 (Review Focus #5)
  - a body over 1 MB gives 413

  Implement, pass, commit.

### Task 3: Cloudflare connector, plus executing purge

**Files:** `packages/connectors/cloudflare/src/{index.ts,client.ts,cloudflare.test.ts,fixtures/*.json}`, registered in the runtime; the M16 executor gains the platform path.

**Interfaces:**
- **Credentials:** `apiToken` (secret), `webhookSecret` (optional, secret). Config: `{ accountId? }`.
- **`validate`:** `GET /user/tokens/verify` must be active. Probes: `GET /zones?per_page=1` (Zone Read) and `GET /zones/:id/dns_records?per_page=1` (DNS Read). Each missing one is listed in `missingPermissions`, for example "Zone: DNS: Read".
- **`discover`:**
  - observations `cloudflare_zone`: `{ name, status, plan, nameServers }`
  - observations `dns_record` per zone: `{ type, name, content, proxied, ttl }`, at most 1,000 per zone
  - `certificate_pack`: status and expiry, when the token can read SSL
- **`health`:** token verify and the zone count.
- **`ingestEvent`:** a Cloudflare notification (`alert_type`, `text`, `ts`) becomes `dns_change` or `security_event`.
- **`executeAction({ kind: 'purge_cache', zoneId, urls | everything })`:** uses the M16 `cloudflarePurge` adapter.
- **M16 executor:** platform capabilities with a connection (`target.connectionId`, same organization, provider `cloudflare` or `github`) run in the API through `runtime.executeAction` and record the adapter result and verification. Proposals no longer answer `connection_required` when the connection exists.

- [ ] Failing tests (recorded fixtures through a fake HTTP server):
  - TC-06-01: the token verifies and the connection becomes connected; missing DNS read gives `permission_denied` listing "Zone: DNS: Read"
  - TC-06-02: a fixture zone with 3 records gives 3 `dns_record` observations
  - a notification gives a `dns_change` event
  - purge executes and verifies; a 403 fails with the reason
  - API: a purge proposal is approved and runs through the connection, then succeeds

  Implement, pass, commit.

### Task 4: GitHub connector, plus executing workflow dispatch

**Files:** `packages/connectors/github/src/{index.ts,client.ts,github.test.ts,fixtures/*.json}`.

**Interfaces:**
- **Credentials:** `token` (fine-grained PAT), `webhookSecret`. Config: `{ owner, repositories?: string[] }`.
- **Client wrapper:** allowlisted path patterns only:
  - `/user`
  - `/repos/:o/:r`
  - `/repos/:o/:r/actions/workflows*`
  - `/repos/:o/:r/actions/runs*`
  - `/repos/:o/:r/deployments*`
  - `/repos/:o/:r/releases*`
  - `/repos/:o/:r/branches`
  - `/users/:o/repos`, `/orgs/:o/repos`, `/installation/repositories`

  `/secrets` and anything else throws `forbidden_endpoint` (TC-06-05).
- **`validate`:** `GET /user` and a repository listing; 401 gives `reauthorization_required`.
- **`discover`:** `github_repository` `{ fullName, defaultBranch, visibility, url }`, workflows, last deployments, and the latest release.
- **`ingestEvent(headers.event, payload)`:**

  | Event | Change event |
  |---|---|
  | `deployment_status` success | `deployment` (failure: `deployment_failed`) |
  | `workflow_run` completed with failure | `workflow_failed` |
  | `release` published | `release` |
  | `push` to the default branch | `push` |
  | `installation` or `github_app_authorization` revoked | the connection becomes `revoked` (TC-06-08) |

- **`executeAction({ kind: 'workflow_dispatch', repo, workflow, ref })`:** the M16 adapter.

- [ ] Failing tests:
  - discovery from fixtures
  - TC-06-03 normalization for each event
  - TC-06-05: a secrets path is refused by the wrapper
  - 403 with `x-ratelimit-remaining: 0` gives `rate_limited` with the reset time
  - dispatch verifies a run appeared

  Implement, pass, commit.

### Task 5: Prometheus Mode A and Grafana

**Files:** `packages/connectors/{prometheus,grafana}/src/*` with tests.

**Interfaces:**
- **Prometheus:**
  - config `{ baseUrl }`; credentials `{ bearerToken? | username?, password? }`; execution `cloud` or `private`
  - `validate`: `/api/v1/status/buildinfo`
  - `discover`: `/api/v1/targets` (at most 1,000) gives `prometheus_target` `{ instance, job, health, labels }`; also rules and alerts counts
  - `collect(query)`: planned with the hosted limits; over-limit throws `invalid_config` before any request (TC-06-07)
- **Grafana:**
  - config `{ baseUrl }`; credentials `{ serviceAccountToken }`
  - `validate`: `/api/health` and `/api/search?limit=1`
  - `discover`: `grafana_dashboard` `{ uid, title, folder, url }`

- [ ] Failing tests:
  - fixtures produce targets and dashboards
  - TC-06-06: target `instance="10.0.0.5:9100"` gives a host observation with ip 10.0.0.5 (the matching itself is in Task 6)
  - an over-limit query is refused without a request

  Implement, pass, commit.

### Task 6: Inventory into assets, and change events everywhere

**Files:** `apps/api/src/modules/discovery/discovery.service.ts`, `apps/api/src/modules/ai/tools.ts` (`getDeployments`), `apps/worker/src/report-sources.ts` (a `deployments` source), `packages/reports/src/snapshot.ts`, `packages/alerting` (correlation lists change events within 2 h before the incident).

**Behavior:**
- **`DiscoveryService.run`** reads inventory from connections scoped to the product (`connection_resource_scopes`, or every item when no scope is set):

  | Inventory item | Becomes |
  |---|---|
  | zone | `domain` asset, stable key `cloudflare:zone:<id>`, with DNS records as attributes |
  | repository | `repository` asset, stable key `github:repo:<id>` |
  | Prometheus target | `host` with weak identity `{ name: hostname or IP, ip }`; it matches an agent host only when the IP or hostname matches (an alias candidate otherwise, M9 rules); `job` becomes `service` with a `MONITORED_BY` edge to the connection's external asset |

- **AI `getDeployments`** returns change events of kind `deployment`, `deployment_failed`, `release`, or `push` in the window. Missing evidence is no longer "source not connected" when a GitHub connection exists.
- **Reports:** the section "Recent deployments" uses the same query, and stays missing only when there is no deployment source.

- [ ] Failing tests:
  - discovery run with a zone, a repository, and a target matching an agent host IP: assets are created and the host is merged by IP (TC-06-06)
  - AI `getDeployments` returns a seeded deployment
  - report snapshot `deployments` is `ok` with the count

  Implement, pass, commit.

### Task 7: Integrations UI

**Files:** `apps/web/app/(app)/orgs/[orgId]/products/[productId]/integrations/{page.tsx,[connectionId]/page.tsx}` and `apps/web/components/integrations/*`; nav "Integrations" enabled (`connection.view`).

**Screens:**
- **Catalog cards** for Cloudflare, GitHub, Prometheus, and Grafana. Each connect wizard shows:
  - requested permissions (copy-ready token scope list)
  - execution location
  - data collected and frequency
  - whether changes are supported
  - the credentials form
- **Connection detail:**
  - status, reason, and missing permissions
  - discovered inventory, with checkboxes to scope it to this product
  - the webhook URL with a copy button, and its secret entry
  - the webhook delivery log
  - recent change events
  - sync history
  - Validate now, Discover now, and Delete

- [ ] Failing tests:
  - the wizard lists the Cloudflare permissions and refuses an empty token
  - the detail page scopes selected zones, shows the webhook URL, and the delivery log rows

  Then the nav test. Implement, pass, commit.

### Task 8: Exit gate, deploy, docs

- [ ] **Playwright `integrations.spec.ts`** (the e2e stack has no internet):
  1. Connect GitHub against a fake GitHub server in the e2e stack (`PCP_PROVIDER_BASE_URLS` override in the e2e override only).
  2. Discovered repositories are scoped.
  3. A signed `deployment_status` webhook posted to `/webhooks/github/:id` appears under change events and in the AI answer.
- [ ] **Full pipeline.** Deploy: migration 0012, plus api, web, and worker.
- [ ] **Production check:**
  - a forged webhook gives 401
  - Prometheus and Grafana connect to the public demo instances (`https://prometheus.demo.prometheus.io`, `https://play.grafana.org`) when reachable: targets and dashboards are discovered
  - real Cloudflare and GitHub connections need the user's tokens; the steps are in the runbook
- [ ] **Docs:** the WB-06 checklist, the board, `M7-execution-log.md`, and the handoffs. Push and update memory.
