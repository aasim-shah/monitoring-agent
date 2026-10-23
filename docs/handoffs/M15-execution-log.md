# Execution Log — M15 Reports and Schedules

| | |
|---|---|
| **Plan** | `docs/superpowers/plans/2026-10-23-m15-reports.md` |
| **Branch** | `feat/m15-reports` (stacked on `feat/m13a-websites`) |
| **Executed** | 2026-10-23/24, inline, test-first. Final review was a self-review (no subagent). |
| **Deployed** | `https://monitor.aasimshah.com` (migration 0010; api, web, migrate, and worker images; the worker gets `VM_QUERY_URL` and the AI keys; other VPS sites unchanged) |

## Ledger

```text
# SDD ledger — plan: docs/superpowers/plans/2026-10-23-m15-reports.md
Spec: spec §12.4, §13.2–13.3; inital.md §13; master plan M15.1–M15.3, D21, Review Focus #3; WB-15; branch feat/m15-reports stacked on feat/m13a-websites.
Pre-flight: T1 tables/functions consumed by T3 dispatcher+handlers and T4 API — consistent; T2 reportWindow/nextRunAt/buildSnapshot/narrate/renderReport consumed by T3 and T4 preview — consistent; T3 sendToChannel extraction consumed by M12 incident deliveries — must stay green; T4 routes consumed by T5 UI — consistent.
Ruling: plan executed without separate review — user asked to continue development (standing inline method) — cost if wrong: re-plan.
Ruling: report_templates table deferred; daily template in code — only one template until weekly/monthly (WB-15 open item) — cost if wrong: add table when templates become editable.
Ruling: nonexistent local times shift forward by the DST gap (Luxon default, 02:30 → 03:30) — deterministic and documented — cost if wrong: one function.
Task 1: complete (commits 0ab9df8..09781a7, tests: bash -c 'cd packages/database && npx vitest run src/reports.int.test.ts src/rls.int.test.ts src/schema-drift.int.test.ts && cd ../jobs && npx vitest run' →    Duration  10.59s (transform 481ms, setup 0ms, import 2.17s, tests 8.99s, environment 0ms))
Side fix: website probe names a certificate issued to another host (user report: demo-app.fyrestorage.com serves Akamai's default certificate) — fe3e616 on feat/m13a-websites, worker deployed; probe 9/9, worker website 6/6.
Side fix: TXT verification at authoritative nameservers (user: getrestro.com record hidden by resolver caches) — 1355852 on feat/m13a-websites; api, web, worker deployed.
Task 2: Ruling: reportWindow(timezone, runAt) without localTime — the window depends only on the run's local day — cost if wrong: none; T3/T4 call it with the scheduled run instant.
Task 2: Ruling: renderReport returns its own ReportMessage (same shape as the M12 Message) — avoids a reports → notifications dependency — cost if wrong: none.
Task 2: complete (commits 9268cb3..cad9039, tests: bash -c 'cd packages/reports && npx vitest run && cd ../ai-orchestrator && npx vitest run' →    Duration  642ms (transform 324ms, setup 0ms, import 484ms, tests 372ms, environment 0ms))
Task 3: Ruling: website coverage "partial" when a verified monitor has no samples in the window; host/log partial-day detection deferred — needs per-series first-sample queries — cost if wrong: a source connected mid-day shows as ok rather than partial.
Task 3: Ruling: regeneration and "Run now" need the schedule (entity = schedule); a report whose schedule was deleted cannot be regenerated — cost if wrong: one 409 path in the API.
Task 3: Ruling: a regenerated version is delivered again to the schedule's channels — recipients get the corrected report — cost if wrong: one flag.
Task 3: complete (commits cad9039..a34c3ae, tests: bash -c 'cd apps/worker && npx vitest run && cd ../../packages/notifications && npx vitest run && cd ../reports && npx vitest run && cd ../ai-orchestrator && npx vitest run' →    Duration  706ms (transform 377ms, setup 0ms, import 609ms, tests 413ms, environment 1ms))
Task 4: Ruling: TenantScope gains { body: 'productId' } so POST /api/v1/report-schedules matches spec §15 — the guard reads the parsed JSON body before the handler — cost if wrong: one decorator option.
Task 4: Ruling: preview is product-scoped (GET products/:id/report-schedules/preview) — every route needs a tenant scope — cost if wrong: none.
Task 4: Ruling: Run now and Regenerate queue `<localDate>__v<n>` (never late); the scheduled run queues `<localDate>` (version 1) — unique (schedule, date, version) keeps one row per version — cost if wrong: none.
Task 4: complete (commits a34c3ae..6a91f28, tests: bash -c 'cd apps/api && npx vitest run src/modules/reports src/modules/websites src/modules/alerting && cd ../.. && node --test scripts/__tests__/openapi.test.mjs' → ℹ duration_ms 343.113512)
Task 5: complete (commits 6a91f28..3538ae4, tests: bash -c 'cd apps/web && npx vitest run && cd ../../packages/reports && npx vitest run' →    Duration  542ms (transform 365ms, setup 0ms, import 677ms, tests 85ms, environment 0ms))
Task 6: Ruling: e2e asserts mail text with CRLF-tolerant patterns, and opens the history by URL after Regenerate — mail bodies travel with CRLF; the client navigation right after the action did not register (same as M12) — cost if wrong: none.
Final review: self-review (no subagent without the user's request).
Final: fixed resuming a long-paused schedule kept next_run_at in the past (one report per missed day) — reports.int.test "resuming a long-paused schedule starts from the next run" RED→GREEN, api reports 8/8
Final: minor (deferred): "partial" coverage only for websites; hosts and logs connected mid-day show as complete.
Final: minor (deferred): email bounces are recorded per delivery, but the owner is not notified after 3 consecutive bounces (needs Resend bounce webhooks).
Final: minor (deferred): weekly/monthly templates and editable report_templates (WB-15 open item).
Task 6: complete (commits 3538ae4..9a8f356, tests: turbo 94/94; repo 58/58; spectral; go; smoke 15/15; e2e 8/8; agent-e2e 5/5; prod check OK with real Gemini, verified)
```

## Results

- **Exit gate (Playwright, `reports.spec.ts`):**
  1. A schedule at 08:00 Asia/Karachi, with the preview "08:00 (03:00 UTC) · covers 24 h".
  2. Run now: the worker generates the 12 sections with a verified scripted summary and emails the Ops channel through Mailpit, with "Data coverage and missing sources" and "Google Analytics not connected (M13b)".
  3. The report view shows missing sections as "No data", coverage, and the delivery log as Sent.
  4. Regenerate adds version 2 and keeps version 1.
- **Full pipeline:**

  | Stage | Result |
  |---|---|
  | turbo | 94/94 |
  | `test:repo` | 58/58 |
  | spectral | clean |
  | Go | pass |
  | smoke | 15/15 |
  | e2e | 8/8 |
  | agent-e2e | 5/5 |

  The first turbo run timed out one web dialog test under load; the test and the component were sped up, and the rerun passed.
- **Production check:**
  - A test organization at 08:00 Asia/Karachi: the preview gave the next run at 2026-10-24T03:00Z over 24 h.
  - Run now generated the report in 12 s, with real Gemini (`gemini-2.5-flash`), `verified`.
  - The 12 sections included missing sources with their reasons.
  - The email was delivered through Resend.
  - The schedule was deleted afterwards.
- **Deploy:**
  - A `pg_dump` was taken first, and the env was backed up to `/opt/pcp/backups/env-pre-m15.bak`.
  - The four superseded pcp images were removed by ID, and the disk is back at 89 %.
  - All 22 nginx sites answered the same before and after.
- **Side fixes during M15** (on `feat/m13a-websites`, deployed):
  - The website probe names a certificate issued to another host.
  - TXT verification asks the zone's own nameservers.
