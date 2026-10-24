# Execution Log — M19 Hardening (production-critical subset)

| | |
|---|---|
| **Plan** | `docs/superpowers/plans/2026-10-25-m19-hardening.md` |
| **Branch** | `feat/m19-hardening` (stacked on `feat/m13b-google`) |
| **Executed** | 2026-10-25, inline, test-first. Final review was a self-review (no subagent). |
| **Deployed** | `https://monitor.aasimshah.com` (migration 0014; api, web, migrate, worker; host timers pcp-backup and pcp-watchdog; other VPS sites unchanged) |

## Ledger

```text
# SDD ledger — plan: docs/superpowers/plans/2026-10-25-m19-hardening.md
Spec: spec §17, §19, §11.13; master plan M19.1, M19.3, M19.5, M19.8; WB-17; branch feat/m19-hardening stacked on feat/m13b-google.
Pre-flight: no shared interfaces between tasks except Task 4 reading Task 1 backup age — consistent.
Ruling: M19 production-critical items before M10/M17/M18 — the deployment has no automated backups — cost if wrong: order only.
Ruling: pentest, load tests against prod, and the pilot are out of scope (need people or would load the shared VPS) — cost if wrong: done later.
Task 1: Ruling: backups stay on the VPS disk (14 days); no off-host storage is configured — none was provided — cost if wrong: a lost disk loses backups; runbook says to copy off-host.
Task 1: complete (commit 3901a67, tests: smoke/backup 5/5)
Task 2: Ruling: script-src keeps 'unsafe-inline' — Next.js hydration inline scripts need it without nonce middleware — cost if wrong: weaker XSS defense than nonces; follow-up.
Task 2: complete (commit a559dd0, tests: web security-headers 3/3; smoke header check runs with the pipeline)
Task 4: complete (commit c3d9b87, tests: smoke/watchdog 2/2; SMTP delivery verified on the VPS at deploy)
Task 3: complete (commit ed48d7d, tests: turbo test 55/55 tasks on zod 4.6.7; pnpm audit:prod clean)
Task 5a: Ruling: routes follow the existing OpenAPI plan (DELETE /organizations/:id, POST .../deletion/cancel 204) — the spec already named them — cost if wrong: none.
Task 5a: Ruling: cancelling restores member access only; revoked agents and disconnected connections stay so (re-enroll, reconnect) — WB-17 revokes them at request time — cost if wrong: owner re-setup after a cancel.
Task 5a: complete (commit f21e841, tests: database tenant-lifecycle 4/4, rls 115/115; api tenants 11/11; shared-contracts 16/16; openapi 4/4)
Task 5b/5c: Ruling: export archives are stored gzip in PostgreSQL (bytea), not on a volume — small tenants, one store to back up and expire — cost if wrong: large tenants bloat the database; cap is 100k rows per table.
Task 5b/5c: Ruling: audit entries of a purged organization are deleted by a scheduler-only definer function; deleted_organizations keeps name, dates, and row counts (WB-17 'audit summary kept') — cost if wrong: if full audit retention is legally required, keep audit_logs instead.
Task 5b/5c: complete (commit b0b8bc1, tests: worker tenant-handlers 3/3, api tenants 13/13, database lifecycle 4/4, openapi 4/4)
Task 5d: complete (commit 4919909, tests: web incl. tenant-data 3/3)
Task 6: fixed: lost task on agent restart (abandoned long-poll claimed it) — tasks.int 'a long-poll whose agent went away' RED→GREEN, api agents+actions+logs+connections 114/114; this was the intermittent M16 agent-e2e timeout.
Task 6: pipeline: format, lint, typecheck, turbo test 55/55, repo, openapi, audit:prod clean, go, smoke 29/29 (+disk guard), Playwright 11/11, agent-e2e 6/6 after the lost-task fix.
Task 6: deployed 2026-10-25: migration 0014; api, web, migrate, worker; pcp-backup.timer (02:30 UTC) and pcp-watchdog.timer (2 min) installed under /etc/systemd/system/pcp-*; first backup verified; restore drill on the VPS restored 11 organizations, 13 users, 7 connections into a throwaway container; watchdog 5/5 checks healthy; test alert mailed to the owner; CSP/Referrer/Permissions headers live; 22 sites unchanged.
Final review: self-review (no subagent tool used).
Final: minor (deferred): backups stay on the VPS disk; copy them off-host (runbook).
Final: minor (deferred): script-src keeps 'unsafe-inline' (no nonce middleware yet).
Final: minor (deferred): external pentest, load-test baselines (k6), self-hosted packaging, and the pilot are not done (need people or a separate host).
Task 6: complete
```

Runbooks: [backup and restore](../runbooks/backup-restore.md), [watchdog](../runbooks/watchdog.md).
