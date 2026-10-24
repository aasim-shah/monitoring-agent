# M10 Monitoring Packs (remainder) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close M10: the edge drop-label filter, per-tenant usage with warnings and owner notice, live boost, and Level 2 guided setup with verification.

**Architecture:**
- The agent's compiled collector config gets a `transform/drop_labels` processor.
- The ingest gateway, which already refuses new series past its limits, reports per-tenant usage to the API every 60 s over the internal token.
- The API stores usage, warns, and emails the owner at most once an hour.
- Live boost is a signed agent task with an agent-side TTL.
- Level 2 guides are static per pack. Their verification queries VictoriaMetrics for the pack's deep metric.

**Spec:** spec §8.8–§8.10, §11.6; master plan M10.5–M10.7; WB-11 UC-11-04, UC-11-07, UC-11-11; BR-11-06, BR-11-08.

## Global Constraints

- **Dropped labels (BR-11-06, §11.6):** `user_id`, `session_id`, `request_id`, `trace_id`, `span_id`, `url.full`, `http.url`, `http.target`, `url.query`.
- **Routes:** `http.route` and `url.path` values have numeric or UUID path segments replaced with `:id`.
- **Limits:** a request is refused and never dropped silently. The dashboard shows the refusal and the owner is told, at most once an hour (TC-11-08).
- **Live boost (BR-11-08):**
  - A 5 s interval for 10 minutes, for one pack, then the agent reverts.
  - The agent reverts on its own TTL even if it is disconnected.
  - At most 3 active boosts per tenant; the 4th is refused with 409.
- **Level 2 (BR-11-04):** the platform shows commands and never runs them. Verification only reads metrics.

## Review Focus

1. A boost whose task arrives after its TTL must not start.
2. An agent restarted during a boost must not stay at 5 s.
3. A gateway usage report from a non-internal caller must be refused.
4. A tenant over its limit sees the warning even after the refusals stop, until the next clean hour.
5. Route normalization must not merge `/v1/` and `/v2/`: only numeric or UUID segments are replaced.

### Task 1: Edge drop-label transform (agent)

- **Code:** `collector.Config` adds `transform/drop_labels` after `memory_limiter` in the metrics pipeline. It uses OTTL statements:
  - `delete_key(attributes, …)` and `delete_key(resource.attributes, …)` for the dropped labels
  - `replace_pattern` on `http.route` and `url.path`
- **Tests:**
  - every compiled config contains the processor in that order, for no packs, every pack, and with logs
  - the OTTL statements name every dropped label
  - `pcp-otelcol validate` passes when `PCP_OTELCOL` is set

### Task 2: Usage reporting, warnings, and owner notice

- **Gateway:** `UsageCounter` per tenant: accepted samples, refused requests, refused new series, and active series from the limiter.
  - Every 60 s it sends `POST /internal/v1/telemetry-usage` with `INTERNAL_TOKEN`.
  - Go tests cover the counter and the reporter (fake server).
- **Database:** migration 0015 adds `telemetry_usage` (organization, minute, active_series, samples, refused_requests, refused_series), with RLS.
- **API:**
  - The internal route stores rows. For organizations with refusals it emails the owners at most once an hour: `organizations.settings.lastLimitNoticeAt`.
  - `GET /api/v1/organizations/:id/usage?range=24h|7d` (`org.view`) returns minute buckets, totals, the limits, and `overLimitSince`.
- **Web:**
  - an Organization → Usage page with active series, samples, and refusals
  - a warning banner on organization pages when refusals happened in the last hour
- **Tests:**
  - API: internal auth, storage, one email per hour, the usage view
  - web: the banner and the page

### Task 3: Live boost

- **`POST /api/v1/agents/:id/live-boost`** `{ packId }` (`telemetry.query`):
  - Needs agent 0.4.0 and a pack enabled on that agent.
  - Creates the signed task `{ type: 'live_boost', payload: { packId, intervalSeconds: 5, untilEpoch } }` with a TTL of 600 s.
  - Records `agent_live_boosts` (organization, agent, pack, expires_at) in migration 0015.
  - Refuses with 409 `boost_limit` when 3 are active.
- **`GET /api/v1/agents/:id/live-boost`:** the active boosts.
- **Agent:**
  - On a `live_boost` task it sets that pack receiver's `collection_interval` to 5 s.
  - It persists `untilEpoch` and reverts at expiry with its own timer, including after a restart.
  - Go tests use a fake clock.
- **Web:** a "Live (5 s)" button per enabled pack on the host page. While active, the chart refreshes every 5 s and shows the remaining time.

### Task 4: Level 2 guided setup and verification

- **Guides:**
  - `nodejs`: OpenTelemetry Node SDK, `NODE_OPTIONS`, `OTEL_*`, metrics to the agent's local OTLP endpoint.
  - `kafka`: the JMX exporter javaagent on 127.0.0.1:7071.
  - `nginx`: `stub_status` on 127.0.0.1.
  - Each guide has its exact commands and the metric that proves it works.
- **`GET /api/v1/agents/:id/packs/:packId/verification`:** looks for that metric for the agent in the last 15 minutes.
  - Returns `active` when found.
  - Returns `waiting` before 15 minutes have passed since the guide was opened.
  - Returns `not_found` with a checklist after that.
- **Web:** a guided setup dialog per pack with copy buttons and a live verification badge.

### Task 5: Exit gate, deploy, docs

- Full pipeline.
- Agent 0.4.0 in downloads.
- Deploy migration 0015, api, web, worker, ingest-gateway, and downloads.
- Production check: the usage page shows the user's agent's series; a boost turns the chart to 5 s on a test agent.
- Docs, push, memory.
