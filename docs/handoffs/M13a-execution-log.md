# Execution Log — M13a Website Monitoring

| | |
|---|---|
| **Plan** | `docs/superpowers/plans/2026-10-23-m13a-websites.md` |
| **Branch** | `feat/m13a-websites` (stacked on `feat/m14-ai`) |
| **Executed** | 2026-10-23, inline, test-first. Final review was a self-review (no subagent). |
| **Deployed** | `https://monitor.aasimshah.com` (migration 0009; api, web, migrate, and worker images; other VPS sites unchanged) |

## Ledger

```text
# SDD ledger — plan: docs/superpowers/plans/2026-10-23-m13a-websites.md
Spec: spec §6.2, §7.4; master plan M13.5, D23, §3 probes; WB-09; branch feat/m13a-websites stacked on feat/m14-ai.
Pre-flight: T1 table consumed by T3 worker and T4 API — consistent; T2 probe/verifyDomain consumed by T3 — consistent; T3 templates consumed by T4 recommended rules and T5 UI — consistent.
Ruling: M13 split; M13a = website monitoring (no external dependency), M13b = Google OAuth/GA4/Firebase/Search Console/Play plus KPI definitions and freshness (KPIs come from those sources) — cost if wrong: re-order.
Ruling: website alerts are worker-evaluated (monitor rows), not vmalert — the probe already knows consecutive failures and TLS expiry; vmalert would need extra rule plumbing per monitor — cost if wrong: metric-based rule later.
Ruling: monitor management uses pack.manage (operator and up), viewing telemetry.query — monitoring configuration like packs — cost if wrong: permission swap.
Task 1: complete (commits e24511c..8336cd1, tests: database alerting+rls+schema-drift → 98/98)
Task 2: complete (commits 8336cd1..64fb7c3, tests: website-probe → 8/8)
Task 3: complete (commits 64fb7c3..5ee4607, tests: worker 17/17, alerting 24/24, compose 6/6)
Task 4: complete (commits 5ee4607..e303f1b, tests: api websites 4/4 + ai 5/5; openapi 4/4)
Task 5: complete (commits e303f1b..3b69a21, tests: api websites 5/5, web 147/147, typecheck+lint clean)
Task 6: Ruling: e2e seeds verified monitors through SQL; the UI add step asserts the SSRF refusal of http://web:3001/ — the API refuses private targets by design and e2e has no DNS TXT — cost if wrong: the UI create path for a public URL is covered by unit and API tests only.
Task 6: Ruling: the e2e "down" monitor is a missing static asset (/_next/static/…, real 404) — app routes redirect unknown paths to /login (200) — cost if wrong: none.
Task 6: Ruling: e2e worker reconciles schedules every 10 s (RECONCILE_EVERY_SECONDS, e2e override only) — the production minute made the first probe miss the test window — cost if wrong: none in production.
Task 6: Ruling: collector build uses go build -p 2 — AWS SDK packages ran out of memory on the 4 GB Docker VM — cost if wrong: slower collector builds.
Task 6: Ruling: downloads image not redeployed — only a build flag changed, the collector binary is the same — cost if wrong: none.
Task 6: complete (commits 3b69a21..4fe5ba3, tests: turbo 89/90 then fixed api alerting 14/14; repo 57/57; spectral; go; smoke 15/15; e2e 7/7; agent-e2e 5/5; prod check OK)
Final review: self-review (no subagent without the user's request); no Critical or Important findings.
Final: minor (deferred): deleting a monitor has no confirmation step (same as channels).
Final: minor (deferred): Cloudflare-zone verification and private URLs through the agent http-check pack (plan Deferred).
```

## Results

- **Exit gate (Playwright, `websites.spec.ts`):**
  - Adding `http://web:3001/` from the UI is refused ("is a private address").
  - Seeded verified monitors on the e2e web container show Up (200, response time) and Down (404).
  - The response-time and uptime charts render from real samples.
  - One "Website down on web" incident opens. The healthy site opens none.
- **Full pipeline:**

  | Stage | Result |
  |---|---|
  | turbo lint, typecheck, test | 89/90; the outdated recommended-rules assertion was fixed and rerun (14/14) |
  | `test:repo` | 57/57 |
  | spectral | clean |
  | Go | pass |
  | smoke | 15/15 |
  | e2e | 7/7 |
  | agent-e2e | 5/5 |

- **Production check:** a test organization monitored `https://monitor.aasimshah.com`.
  - Metadata, private, and localhost URLs are refused.
  - Verification without a record names `monitor.aasimshah.com` and `aasimshah.com`.
  - The monitor was marked verified through SQL, because adding DNS records needs the user's approval.
  - Result: Up, 200, 235 ms. The TLS certificate (Let's Encrypt) expires on 2027-01-20. Both charts have data.
  - The monitor was then deleted.
- **Deploy:**
  - A `pg_dump` was taken first.
  - The four superseded pcp images were removed by ID, and the disk is back at 89 %.
  - All 22 nginx sites answered the same before and after.
