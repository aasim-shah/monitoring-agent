# Execution Log — M13b Google Sources and KPIs

| | |
|---|---|
| **Plan** | `docs/superpowers/plans/2026-10-25-m13b-google-kpis.md` |
| **Branch** | `feat/m13b-google` (stacked on `feat/m7-integrations`) |
| **Executed** | 2026-10-25, inline, test-first. Final review was a self-review (no subagent). |
| **Deployed** | `https://monitor.aasimshah.com` (migration 0013; api, web, migrate, worker; other VPS sites unchanged) |

## Ledger

```text
# SDD ledger — plan: docs/superpowers/plans/2026-10-25-m13b-google-kpis.md
Spec: spec §7.2, §7.5, §11.1–11.3; master plan M13.1–M13.3, M13.6, M13.7; WB-08, WB-09; branch feat/m13b-google stacked on feat/m7-integrations.
Pre-flight: T1 metric_aggregates + connection-sync consumed by T3 sync (MetricPoint) and T4 API — consistent; T2 grantedScopes consumed by T3 services() and T6 grid — consistent; T4 KPI catalog consumed by T5 and T6 — consistent.
Ruling: plan executed without separate review — user asked to complete every Soon item — cost if wrong: re-plan.
Ruling: Google Ads stays off (pending platform approval) — no developer token exists (M13.4 gated) — cost if wrong: none.
Ruling: BigQuery exports and Cloud Monitoring are not read in this pass; they show as gaps — each needs per-project datasets and billing caps — cost if wrong: Crashlytics KPIs come later.
Task 1: Ruling: granted scopes and the account email are columns on connections, not a separate table — one connection has one grant — cost if wrong: a table later.
Task 1: Ruling: KPI definitions live in code; the database holds values only (metric_definitions table not created) — definitions change with code releases — cost if wrong: one table.
Task 1: Ruling: a rate-limited sync fails its run and waits for the next hourly run (that is the back-off) — GA4 quotas reset hourly/daily — cost if wrong: data up to an hour later.
Task 1: complete (commit 3ddfb9a, tests: database kpis+rls+drift 117/117, runtime 23/23, jobs 10/10, sdk 55/55, mock 4/4)
Task 3: Ruling: connector built before the OAuth endpoints (Task 2) — the API test needs a registered google provider — cost if wrong: none.
Task 3: Ruling: Google is registered only when GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set; the worker now receives both — token refresh needs the client — cost if wrong: none.
Task 3: complete (commit 33a6e09, tests: google 11/11, registry 6/6)
Task 2: Ruling: the OAuth endpoints live in the connections module and reuse the sign-in GOOGLE_HTTP fetch — one HTTP seam for tests — cost if wrong: none.
Task 2: Ruling: the ID token's email is read without signature verification — it comes straight from Google's token endpoint over TLS (OIDC Core 3.1.3.7) and is display-only — cost if wrong: a wrong 'Connected as' label, nothing else.
Task 2: Ruling: openid email are requested beside the data scopes to show 'Connected as' (BR-08-07); sign-in still never requests data scopes (BR-08-01) — cost if wrong: one consent line.
Task 2: complete (commit f93290b, tests: api connections 30/30 incl. google-connect 7/7; api-client 5/5; spectral 0 errors)
Task 4: Ruling: active users over a range are the daily average, not a sum — summing days double-counts people — cost if wrong: a label change.
Task 4: Ruling: a source is stale when its latest sync failed or the last success is over 2 h old (hourly sync) — spec §11.3 needs an expected interval — cost if wrong: a threshold.
Task 4: complete (commit 0c37317, tests: shared-contracts 15/15 incl. kpis 3/3, api kpis 4/4, google 11/11, openapi 4/4, api-client 5/5)
Task 5: Ruling: the reauthorization email goes to the member who connected and the organization owners — WB-08 says 'owner notified once'; the connector of record should know too — cost if wrong: one more recipient.
Task 5: Ruling: the notice test was written alongside the code, not before it — noted honestly — cost if wrong: none (it asserts recipients, subject, and link).
Task 5: complete (commit 776862d, tests: api ai+reports 15/15, worker report-handlers 12/12, reports 27/27, web reports 7/7)
Task 6: Ruling: the KPI API also lists scoped Firebase apps (no daily values) so the Mobile page needs no second endpoint — cost if wrong: none.
Task 6: complete (commit 3bc5904, tests: web 172/172 incl. google 3, analytics 2, nav; api kpis 4/4)
Task 7: Ruling: saving a scope on a connector with sync queues connection-sync immediately — otherwise new scopes wait up to an hour (found by the e2e) — cost if wrong: one extra sync per save.
Task 7: fixed: e2e reload raced client-side navigation — waitForURL before reload; google.spec RED→GREEN.
Task 7: pipeline: format, lint, typecheck, turbo test 55/55 tasks, test:repo, openapi, go, smoke, Playwright 11/11; agent-e2e 6/6 on rerun (the M16 restart check timed out in 2 of 4 runs with the task sent and no result; host logs now print on timeout).
Final: minor (deferred): intermittent M16 agent-e2e restart timeout — not reproduced with logs yet; M13b does not touch that path.
Final review: self-review (no subagent tool used).
Task 7: deployed 2026-10-25: migration 0013; api, web, migrate, worker; 22 sites unchanged; callback and KPI routes answer 401 without a session; the worker's Google connector reached oauth2.googleapis.com and a fake refresh token came back reauthorization_required (client and egress work).
Final: minor (deferred): BigQuery exports, Cloud Monitoring/Logging, and Tag Manager are requested but not read.
Final: minor (deferred): Google Ads waits for a developer token (M13.4).
Final: minor (deferred): real data needs the Google Cloud setup in M13b-google.md (APIs enabled, redirect URI, consent screen).
Task 7: complete
```

Setup steps for real Google data: [M13b-google](M13b-google.md).
