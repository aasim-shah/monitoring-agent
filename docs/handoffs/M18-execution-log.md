# Execution Log — M18 Retained logs, data inspection, Level 1 exporters, rollups

| | |
|---|---|
| **Plan** | `docs/superpowers/plans/2026-10-25-m18-logs-inspection-rollups.md` |
| **Branch** | `feat/m18-logs-inspection` |
| **Executed** | 2026-10-25, inline, test-first. Final review was a self-review (no subagent). |
| **Deployed** | `https://monitor.aasimshah.com` (M18 and M19 together; migrations 0017, 0018; other VPS sites unchanged) |

## Ledger

```text
# SDD ledger — plan: docs/superpowers/plans/2026-10-25-m18-logs-inspection-rollups.md
Spec: spec §8.9, §11.8, §11.9, §11.12; master plan M18; WB-12, WB-11; branch feat/m18-logs-inspection stacked on feat/m17-install.
Pre-flight: Task 1 and Task 3 both add to migration 0017 (one migration, two parts); Task 4 reuses the M16 action flow and pcp-helper — consistent.
Ruling: order is inspection, rollups, retained logs, Level 1 (value per hour on the shared VPS) — cost if wrong: order only.
Task 1: Ruling: AI gets no inspection tool at all (stricter than "counts only") — simplest way to guarantee BR-12-07 — cost if wrong: an AI tool for counts later.
Task 1: Ruling: big-key SCAN is not offered — the spec allows it off-peak and rate-limited, but exact allowlisted keys cover the queue-depth use; no SCAN means no pattern load on a busy Redis — cost if wrong: users list key names themselves.
Task 1: Ruling: database migration test and models were written together (test in the same step) — schema tests pin the result — cost if wrong: none seen.
Task 1: Ruling: the AI guard test (tools.test.ts) pins existing behaviour and passed on first run by design — cost if wrong: none.
Task 1: complete (commit 83d2543, tests: go inspect 7/7 incl. guard, Redis fake, kfake overview/peek, task runner; database 128/128; api inspections 4/4, ai tools 1/1, tasks+actions 7/7, packs 14/14; shared-contracts 17/17; web services 17/17 incl. inspection-panel 4/4; agent-e2e added to M6b test, runs in the pipeline)
Task 2: Ruling: rollups cover host, website, and log-count series only (the dashboard charts that span weeks); pack series are not rolled up and service charts stop at 7 days — cost if wrong: more recording rules later.
Task 2: Ruling: routing switches on when the range starts before raw retention (15 d), not at a fixed 30 d — between 15 and 30 d raw data is gone anyway — cost if wrong: none.
Task 2: Ruling: the feature flag is the compose profile `rollups` plus ROLLUPS_SINCE in the api — cost if wrong: none.
Task 2: complete (commit 0812e1a, tests: api telemetry limits 11/11 + rollups.int 1/1 + telemetry 26/26, config; smoke rollups 3/3 incl. vmalert replay; web suite)
Task 3: Ruling: card numbers in retained logs are masked as any 13-19 digit run (OTTL has no Luhn check), stricter than the live tail — cost if wrong: some long numbers masked.
Task 3: Ruling: ProjectID is 0 and the product is a stamped field filtered by the API (VictoriaLogs ProjectID is a number; AccountID isolates tenants) — cost if wrong: none for isolation.
Task 3: Ruling: search needs logs.tail (same as live viewing); user queries cannot contain pipes and are wrapped in parentheses so OR cannot widen the product filter — cost if wrong: no pipe-based analytics in search.
Task 3: verified by hand: contrib collector 0.162.0 with the generated transform/redact_logs masked auth header, URL password, token, email, password, card, and JWT in a sample file.
Task 3: complete (commit 8305769, tests: go collector incl. TestRetainedLogs, packs apply 1, logs, gateway logs 2; database 129/129; api retained-logs 3/3 + agents/packs/logs/telemetry/inspections 117/117; web logs+services 29/29; smoke retained-logs 1/1; agent-e2e in pipeline)
Task 4: Ruling: the exporter catalog (versions, checksums) is compiled into pcp-helper; the signed task names only the exporter, the download origin, and the loopback target — a compromised control plane cannot make the helper install another binary — cost if wrong: a helper release per exporter update.
Task 4: Ruling: pack installer opt-in lives in helper.yaml (pack_install.enabled), written by --enable-pack-installer, plus a ProtectSystem=true drop-in for the helper (ProtectSystem=full makes /etc read-only, which blocks useradd and unit files) — cost if wrong: helper on those hosts can write /etc.
Task 4: fixed: the Task 3 retained-logs toggle was never wired into the service charts (a text replacement missed after reformatting); wired now with assertions — cost: none shipped (not deployed).
Task 4: Ruling: managed-exporter button and redaction helpers were written with their tests in one step — cost if wrong: none seen.
Task 4: complete (commit 0af4307, tests: go helper incl. exporters 6, collector exporter packs; automation 19/19; api actions/packs/telemetry 55/55 incl. exporters.int; web 31+; agent-e2e Level 1 added, runs in the pipeline)
Task 5: pipeline (run on feat/m19-selfhosted, which contains M18): build, format, lint, typecheck, repo, openapi, audit, go+vet, smoke, Playwright; turbo test 55/55 on rerun (first run: worker tenant purge timed out under parallel load, 3/3 alone); agent-e2e 11/11 after two fixes below.
Task 5: fixed: exporter actions failed verification (checked a restart's activeState) — exporters.int asserts the action succeeds with {listen:'127.0.0.1:9121', verified:true} (f480d62).
Task 5: fixed (test): the retained-log e2e marker ended in Date.now(), which retained-log redaction masks as a card number; the line was stored redacted under the right AccountID and product — marker is now hex (d9c2261).
Task 5: Ruling: retained-log redaction masks every 13–19 digit run (no Luhn in OTTL), so epoch-millisecond timestamps inside log lines are masked too — privacy first — cost if wrong: less useful numbers in retained lines.
Task 5: Ruling: on the shared VPS the logs and rollups profiles stay off (3.7 GB RAM, 90 % disk); the code ships with them flagged off — cost if wrong: features unused in production until a bigger host.
Task 5: deployed 2026-10-25 with M19 from feat/m19-selfhosted: migrations 0017, 0018; migrate, api, web, worker, ingest-gateway, downloads (agent 0.5.0, exporters), installer-runner; pre-m18 pg_dump; resumable rsync, sha256 matched; three load batches with old images removed by ID between them (VPS 90 % disk); 22 sites unchanged; agent 0.5.0 and redis_exporter tarball 200; inspections and log search refuse unauthenticated (401). logs and rollups profiles not started on the VPS.
Final review: self-review (no subagent tool used).
Final: minor (deferred): Kafka overview sizes rely on DescribeLogDirs; brokers that refuse it show sizes as unknown.
Final: minor (deferred): retained-log search returns the newest 500 lines without paging.
Task 5: complete
```
