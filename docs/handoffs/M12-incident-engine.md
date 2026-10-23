# Handoff — M12.2 Incident engine

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-23 |
| **Branch** | `feat/m12-alerts` |
| **Plan** | M12 plan Task 3 |
| **Workbooks** | WB-13 UC-13-04/05/06/07/08, BR-13-02/03/04/05 |

## Delivered (`packages/alerting/src/engine.ts`)

- **`ingest(tx, orgId, alerts, now)`** runs inside the caller's tenant transaction. It returns `{opened, reopened, updated, resolved, notify}`. Alerts for rules the tenant cannot see are skipped.
- **Fingerprint:** `sha256(org, rule, sorted labels)`, ignoring `alertname` and `alertgroup`. Only one unresolved incident exists per fingerprint (`open_fingerprint`).
- **Firing:**
  - An open incident with this fingerprint is kept, and a `refired` event is added at most every 5 min.
  - Else, if it was resolved less than 30 min ago, it is reopened.
  - Else a new incident is created with:
    - the title `<rule> on <host> (<mountpoint or service>)`
    - a correlation (the host asset `agent:<id>`, then `computeImpact` at depth 4 within the rule's product)
    - a deterministic summary
- **Resolved:** the incident becomes `resolved` with the note "Condition cleared".
- **Notifications** produce notify requests plus a `notified` event:
  - **Opening notices:** sent when the incident opens or reopens, unless the incident was notified less than 30 min ago. In that case a `suppressed` event is recorded instead.
  - **Resolution notices:** sent only to answer an opening or escalation notice that has not been answered yet. A flapping alert therefore sends exactly one opening and one resolution notice.
- **`acknowledge`** works on open incidents only. **`resolveManually`** takes a note. **`escalate(tx, now)`** escalates critical incidents that are still open after 15 min, once each.
- **`summarize`** never names a cause. It says "Correlated with N assets: …" or "No related assets are known in the asset graph yet."
- **Refactor:** the blast-radius query moved to `@pcp/discovery-engine` as `computeImpact`. The API's Assets page uses the same function; its tests are unchanged and pass.

## Tests

`engine.int.test.ts` (9 tests, real PostgreSQL with RLS):
- duplicate firings produce one incident and one notice
- an alert resolve resolves the incident with one notice
- 6 flaps give one incident, 5 reopens, 6 resolves, and the notices `opened` and `resolved` only
- a return after 30 min opens a new incident
- tenants stay apart with identical labels, and a cross-tenant rule is skipped
- correlation names the host and lists dependents, and the summary never says "caus…"
- a host unknown to the graph is handled
- acknowledge and manual resolve work
- escalation happens once, critical only
