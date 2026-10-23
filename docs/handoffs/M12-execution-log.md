# Execution Log — M12 Alerts, Incidents, Notifications

| | |
|---|---|
| **Plan** | `docs/superpowers/plans/2026-10-23-m12-alerts.md` |
| **Branch** | `feat/m12-alerts` (stacked on `feat/m11-logs`) |
| **Executed** | 2026-10-23, inline, test-first. Final review was a self-review (no subagent). |
| **Deployed** | `https://monitor.aasimshah.com` (migration 0007; api, web, worker; vmalert started at 64 MB, about 13 MB used; other VPS sites unchanged) |

## Ledger

```text
# SDD ledger — plan: docs/superpowers/plans/2026-10-23-m12-alerts.md
Spec: spec §13.1, §13.2, §13.4, Scenario B; master plan M12.1–M12.4, D17, §3 alerting; WB-13; branch feat/m12-alerts stacked on feat/m11-logs.
Pre-flight: T1 tables consumed by T3 engine and T4 API — consistent; T2 compileTenant consumed by T4 rule-files — consistent; T3 ingest/NotifyRequest consumed by T4 receiver and T5 alert-tick — consistent; T4 job definition alert-tick + queue notification-deliver consumed by T5 processors — consistent; T4 routes consumed by T7 UI — consistent; T6 vmalert notifier → T4 receiver path — consistent.
Ruling: plan executed without separate user review — user asked to continue development — cost if wrong: re-plan.
Ruling: no new permissions — rules and incidents use incident.view / incident.manage, channels use org.settings.manage (admin, owner); the role matrix and spec list stay unchanged — cost if wrong: one permission split later.
Task 1: Ruling: one-unresolved-incident-per-fingerprint via nullable open_fingerprint + plain unique (NULLs distinct) instead of a partial index — Prisma cannot express partial indexes and the schema-drift test would fail — cost if wrong: engine must clear open_fingerprint on resolve.
Task 1: complete (commits 0e5e234..7014955, tests: pnpm --filter @pcp/database test → all passed incl. alerting 3, rls 79+, schema-drift)
Task 2: complete (commits 7014955..e0b9555, tests: pnpm --filter @pcp/alerting test → 6/6 incl. real vmalert TC-13-01)
Task 2: Ruling: product scope via a per-product vmalert group with extra_filters instead of rewriting expressions — no PromQL parsing, same isolation guarantee — cost if wrong: one group per product in the file.
Task 3: Ruling: resolution notices are sent only to answer an unanswered opening/escalation notice (not subject to cooldown otherwise) — a real incident gets "opened" and "resolved" mails, a flapping one exactly that pair; plan's Review Focus #2 said "one notification", pair is the useful reading — cost if wrong: one extra mail per incident.
Task 3: Ruling: impact query moved to @pcp/discovery-engine (computeImpact) so API and worker correlate the same way — cost if wrong: none (API tests unchanged).
Task 3: complete (commits e0b9555..76bf691, tests: pnpm --filter @pcp/alerting test → 15/15; api assets+discovery 10/10)
Task 4: Ruling: receiver answers 401 without/with a wrong token (existing InternalGuard contract), 404 only when internal routes are disabled — plan said 404 — cost if wrong: none.
Task 4: Ruling: tenant guard resolver pcp_resolve_alerting_object added to the not-yet-deployed 0007 migration (separate commit 521090b) — cost if wrong: none (never deployed).
Task 4: complete (commits 76bf691..e8199b9, tests: apps/api vitest alerting+assets+discovery+internal → 22/22; jobs 6/6; alerting pkg 16/16; openapi 4/4)
Task 5: Ruling: connection_degraded uses connections.updated_at as "degraded since" — no status_changed_at column; a later unrelated update can delay the alert — cost if wrong: alert fires later than N minutes for connections updated while degraded.
Task 5: Ruling: without SMTP_URL the worker fails email deliveries (visible dead letters) instead of logging "sent" — cost if wrong: none.
Task 5: complete (commits e8199b9..02e616e, tests: notifications 10/10, alerting 20/20, worker 10/10)
Task 6: complete (commits 02e616e..d7f6ec2, tests: node --test scripts/__tests__/compose.test.mjs → 4/4; vmalert empty-dir probe ok; merged VPS config resolves)
Task 7: complete (commits d7f6ec2..48209fe, tests: apps/web vitest → 133/133 incl. alerting 14, nav 4)
Task 8: e2e debug: vmalert loaded the tenant file, fired after 1 min, receiver opened the incident (pipeline correct). Two harness issues: (1) e2e worker not on Mailpit's edge network (ENOTFOUND mailpit) — e2e override adds edge; prod uses Resend over egress; (2) nav click right after the rule dialog closed did not navigate — test now opens the incidents URL directly.
Final review: self-review (no subagent without the user's request)
Final: fixed rule delete cascaded incidents (history/postmortems lost) — archives instead (archived_at in undeployed 0007) — alerting.int.test "archives the rule…" RED→GREEN, api alerting 9/9, alerting pkg 20/20, database 84/84
Final: minor (deferred): a channel marked broken does not email the owner yet (WB-13 §9 edge case)
Final: minor (deferred): a manual resolve while the condition still fires reopens the incident within a minute (vmalert keeps firing) — Alertmanager-like, may surprise users
Final: minor (deferred): deployment-related rules and change_events wait for M7 change sources
```

## Results

- **Exit gate (Playwright, full stack with real vmalert):**
  - The owner adds an email channel and a CPU rule (above 50 % for 1 min).
  - CPU samples at 97 % go into VictoriaMetrics. vmalert fires, and the receiver opens "Server CPU high on vps-1".
  - The on-call email arrives in Mailpit.
  - The detail page shows "Correlated with 2 assets", the blast radius (Orders API, potential), and the source links.
  - The incident is acknowledged and then resolved with a note, and both actions are audited.
  - This covers Scenario B steps 1–3 and 6.
- **Tenant isolation:**
  - TC-13-01: real vmalert with two tenants' identical series; only tenant A's rule fires, with A's label.
  - The receiver drops a forged tenant and rule pair.
  - Incidents are product-scoped for members.
- **Found while running the gate:**
  - The e2e worker was not on Mailpit's network.
  - A navigation click right after a dialog closed did not register.
  - Both were test-harness issues, not product bugs.
- **Found by self-review:** deleting a rule cascaded to its incidents. It now archives the rule and keeps the history.
- **Pipeline:** turbo 82/82, `test:repo`, spectral, Go, smoke, e2e 5/5, and agent-e2e 5/5.
- **Production check:**
  1. A test organization got an email channel and a heartbeat rule (2 min).
  2. An agent was installed with the production command and then stopped.
  3. 2 min later "Agent heartbeat missing on m12-prodcheck" opened, and the email "[CRITICAL] … — opened" went out through Resend.
  4. The test agent was revoked and its host removed.

## Deferred minors

- A channel marked broken does not email the owner yet (WB-13 §9).
- Manually resolving while the condition still fires reopens the incident within a minute, like Alertmanager.
- Deployment-related rules and `change_events` wait for M7 change sources.

## How to resume

- **Using it:**
  1. Settings → Notifications: add an email, Slack, or webhook channel.
  2. Product → Incidents & Alerts → Alert rules: "Add recommended rules".
  3. Incidents appear when a rule fires on real data.
- **Next:** M14 AI (Gemini, with Groq as fallback) for incident summaries and the assistant. M13 Google (the OAuth client is ready). M7 is waiting for the GitHub OAuth app.
