# M18 Retained Logs, Data Inspection, Level 1 Exporters, Rollups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close the last feature milestone:
- data inspection for Redis and Kafka, read-only and allowlisted, with an opt-in Kafka message peek
- long-term 5-minute rollups kept for 13 months
- opt-in retained logs in VictoriaLogs
- Level 1 managed exporters installed by `pcp-helper` through the approval flow

Every part sits behind a feature flag, sized for the shared VPS.

**Architecture:**
- **Inspection:** a signed `inspect` task (`target: redis | kafka`). The agent runs a fixed command set against the pack's endpoint with the pack's own credentials and returns stats.
  - Kafka peek results are kept in Redis for 10 minutes and are never written to PostgreSQL.
  - Task results for inspections are stored without values.
- **Rollups:** a second VictoriaMetrics, `victoriametrics-longterm`, keeps 13 months. vmalert records 5-minute averages of the dashboard series into it.
  - The telemetry query service reads it for ranges longer than 30 days and reports `completeness`.
- **Retained logs:**
  - **Opt-in:** per pack.
  - **Agent:** the collector ships the pack's log files, redacted with the same rules as the live tail, as OTLP to the ingest gateway.
  - **Gateway:** stamps the tenant's `AccountID` and the product's `ProjectID` and forwards to VictoriaLogs.
  - **Search:** the API searches with the caller's `AccountID` only.
- **Level 1:**
  - **Approval:** an approved action of kind `pack_install` makes `pcp-helper` install a version-pinned exporter.
  - **Exporter source:** downloads, checked against a SHA-256 in the signed task.
  - **Runs as:** a systemd unit bound to `127.0.0.1`.
  - **Removal:** `pack remove` removes the unit and the binary.

**Tech Stack:** Go agent and helper, NestJS, Prisma migration 0017, VictoriaLogs v1.36.1, VictoriaMetrics v1.126.0, vmalert, Next.js, Vitest, agent-e2e.

**Spec:** spec §8.9, §11.8, §11.9, §11.12; master plan M18.1–M18.4; WB-12 (UC-12-04..08, BR-12-05..08, TC-12-06..09), WB-11.

## Global Constraints

- **Inspection is opt-in:** off by default per pack. Only owners and admins enable it, and every enablement and every request is audited (BR-12-06).
- **Redis:**
  - **Allowed:** `INFO`, `DBSIZE`, `SLOWLOG GET`, `LATENCY LATEST`, `CLIENT LIST`, `MEMORY STATS`.
  - **Allowlisted keys only:** `LLEN`, `XLEN`, `SCARD`, `ZCARD`, `MEMORY USAGE`, `TYPE`.
  - **Never:** `MONITOR`, `KEYS`, or any value read.
- **Kafka:**
  - **Allowed:** topics, partitions, `retention.ms`, log-dir sizes, consumer groups with state, members, and lag.
  - **Peek:** only for topics the owner allowlisted, at most 20 messages, redacted, never stored.
- Inspection values never reach AI tools (BR-12-07). AI gets no inspection tool at all.
- Retained logs:
  - off by default
  - kept 7 days (BR-12-08)
  - redacted on the host (BR-12-04)
  - tenant-isolated by `AccountID`
- **Resources (shared VPS):** VictoriaLogs runs with a 128 MiB cap and `-retentionPeriod=7d`; victoriametrics-longterm with a 128 MiB cap.
- Level 1 exporters bind to `127.0.0.1` only. Each runs as its own systemd unit and its own user, and `pack remove` removes the unit, the binary, and the user.

## Review Focus

1. A Redis key allowlist entry with a glob or a space (`*`, `a b`): refused when saved, so no pattern scan ever runs.
2. A Kafka peek on a topic whose messages contain tokens or emails: the redaction corpus masks them before they leave the host.
3. A 90-day query when rollups started 10 days ago: `completeness` says `partial`, with the date the rollups start.
4. Log search with a LogsQL query that names another tenant's stream fields: the gateway and the API always set `AccountID` from the session, so the query cannot widen it.
5. `pack remove` after a failed Level 1 install: no unit, binary, or user is left behind.

---

### Task 1: Data inspection (M18.2)
- Migration 0017:
  - `agent_pack_assignments.inspection jsonb` (`{enabled, redisKeys[], peekTopics[]}`)
  - `inspection_requests` with RLS: id, org, agent, pack, kind, reason, status, requested_by, result (stats only; null for peek), error, created_at, finished_at
- Agent:
  - `internal/inspect/{redis.go,kafka.go,guard.go}`
  - A minimal RESP client. `guard.go` refuses any command outside the allowlist (TC-12-06).
  - Kafka uses franz-go `kadm`. Peek reads at most 20 messages and redacts them with `internal/logs` redaction.
- API: `PATCH /agents/:id/packs/:packId/inspection` (owner or admin, audited), `POST /agents/:id/inspections`, `GET /inspections/:id`. Peek results live in Redis under `inspect:peek:<id>` with a 600 s TTL.
- Web: an Inspection tab on the service page with Redis stats, Kafka topics and groups, a peek panel, and settings.
- Tests:
  - Go: the guard refuses `MONITOR`, `KEYS *`, `GET`, `HGETALL`, `EVAL`, `CONFIG`, `FLUSHALL`. Redis stats come from a fake RESP server. Kafka overview and peek run against kfake. Peek is capped at 20 and redacted.
  - API: owner/admin only; not enabled gives 409; a non-allowlisted topic gives 409; peek results are not in the database; audit records exist.
  - Web: panels.
  - AI: no tool name or output references inspections (TC-12-08).

### Task 2: Long-term rollups (M18.4)
- Compose `victoriametrics-longterm` (`-retentionPeriod=13M`, 128m) and `vmalert-rollups`, which records 5-minute rollups of the dashboard series into it.
- `telemetry-query`: ranges over 30 days read longterm, and the response carries `completeness` (`complete | partial`, with `since`).
- Tests: the query router (unit); a 90-day query with partial rollups reports `partial` (Review Focus #3). The rules file is validated with `vmalert -dryRun` in the smoke test.

### Task 3: Retained logs (M18.1)
- `organizations.logs_account_id` (unique serial) in migration 0017. Compose `victorialogs` (128m, 7d).
- Agent: when a pack's `retainLogs` is on, a `logs/retained` pipeline runs filelog, then a redaction transform, then OTLP to the ingest gateway.
- Gateway: `/v1/logs` authenticates by certificate, stamps `AccountID` and `ProjectID`, and forwards to VictoriaLogs.
- API: `GET /products/:id/logs/search?query=&range=` sets `AccountID` from the tenant and `ProjectID` from the product.
- Web: a Logs search page.
- Tests:
  - gateway forwarding with stamped headers
  - TC-12-09: tenant A never sees tenant B
  - redaction in the collector config
  - the API search proxy

### Task 4: Level 1 managed exporters (M18.3)
- Catalog:
  - **Exporters:** `redis_exporter` and `kafka_exporter`, version-pinned, downloaded with SHA-256 and served from `/downloads/exporters/`.
  - **Pack setting:** `level1`.
- `pcp-helper` gets a `pack_install` and `pack_remove` capability, allowed only when installed with `--enable-pack-installer`.
  - **Install:** the action is approved first, then the helper checks the SHA-256, creates a dedicated user and a systemd unit with `--web.listen-address=127.0.0.1:<port>`, and the collector scrapes it.
  - **Remove:** removes the unit, the binary, and the user.
- Tests:
  - Go helper: refuses without the installer flag; refuses a hash mismatch; the unit binds loopback.
  - agent-e2e: install, check the listener is loopback only, remove, nothing left (Review Focus #5).

### Task 5: Exit gate, deploy, docs
- Full pipeline.
- Deploy migration 0017, api, web, worker, ingest-gateway, downloads (agent 0.5.0), victorialogs, victoriametrics-longterm, vmalert-rollups. The new services are behind the `RETAINED_LOGS` and `ROLLUPS` flags on the VPS.
- Production check, then docs, push, and memory.
