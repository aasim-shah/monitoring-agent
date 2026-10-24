# Execution Log — M16 Operational Actions and Approvals

| | |
|---|---|
| **Plan** | `docs/superpowers/plans/2026-10-24-m16-actions.md` |
| **Branch** | `feat/m16-actions` (stacked on `feat/m15-reports`) |
| **Executed** | 2026-10-24, inline, test-first. Final review was a self-review (no subagent). |
| **Deployed** | `https://monitor.aasimshah.com` (migration 0011; api, web, migrate, and worker; downloads with agent 0.3.0 and pcp-helper; other VPS sites unchanged) |

## Ledger

```text
# SDD ledger — plan: docs/superpowers/plans/2026-10-24-m16-actions.md
Spec: spec §13.5, §18.3, Scenario B 7–8; inital.md §16; master plan M16.1–M16.4, D20; WB-16; branch feat/m16-actions stacked on feat/m15-reports.
Pre-flight: T1 tables consumed by T4 — consistent; T2 evaluatePolicy/canApprove/transition/adapters consumed by T4 — consistent; T3 helper protocol consumed by T4 task payload ({capability:'service_restart', unit}) — consistent; T4 routes consumed by T5 — consistent.
Ruling: plan executed without separate review — user asked to complete all remaining work — cost if wrong: re-plan.
Ruling: pcp-helper trusts only a root-owned copy of the task key (/etc/pcp-agent/task-signing.pub), not the agent state file — a compromised pcp-agent user could otherwise sign its own tasks — cost if wrong: none.
Ruling: Cloudflare and GitHub adapters ship with the engine but proposals need a provider connection (M7) — connectors are not built yet — cost if wrong: none; they light up with M7.
Task 1: Ruling: one running execution per target through a unique nullable running_key (as M12 open_fingerprint) — Prisma cannot model partial indexes and schema drift would flag one — cost if wrong: none.
Task 1: Ruling: an environment is production when its name is production or prod (case-insensitive) — environments have no kind column — cost if wrong: a kind column later.
Task 1: complete (commits 2186f3c..2854187, tests: database actions+rls+schema-drift+alerting+reports → 122/122)
Task 2: complete (commits 2854187..199885a, tests: automation → 17/17)
Task 3: Ruling: the helper re-checks the unit 3 s after it turns active (settle) — catches a unit that crashes right after the restart (WB-16 §9) — cost if wrong: a 3 s longer action.
Task 3: Ruling: a second action on the same host waits for the first in the agent (one at a time) instead of failing — the API already serializes per target — cost if wrong: none.
Task 3: complete (commits 199885a..566543e, tests: go test ./agents/host-agent-go/... → all ok incl. pcp-helper 9; test:repo 58/58)
Task 4: Ruling: approve and reject need action.propose plus one of the policy's approver roles — the role matrix grants action.approve to owners only and defers others to policies (spec §2.1) — cost if wrong: one permission.
Task 4: Ruling: expiry is lazy (on list, get, approve), as agent tasks expire on poll — the alert tick only runs for organizations with rules — cost if wrong: an expired row is shown as pending until someone looks (it can never be approved).
Task 4: Ruling: action results are noted on the incident timeline as kind 'note' with the action ID — no enum migration — cost if wrong: one enum value.
Task 4: Ruling: Cloudflare and GitHub proposals answer 409 connection_required until M7 connectors exist; their adapters are tested in packages/automation — cost if wrong: none.
Task 4: complete (commits 566543e..6cf7dde, tests: api actions 12/12, full api 256/256; openapi 4/4; spectral 3 warnings (pre-existing))
Task 5: complete (commits 6cf7dde..16e22ae, tests: web 162/162 incl. actions 8 and nav; typecheck, lint, production build ok)
Task 6: Ruling: connections.int.test consumed every job kind on the shared test Redis, racing the reports test under turbo — startProcessors gains kinds; reproduced by running both files together (2 failed) → 19/19 — cost if wrong: none.
Task 6: Ruling: Playwright covers policy, proposal, impact, and the production self-approval guard; approval, helper execution, and verification run in agent-e2e against a real helper — a second MFA member in Playwright adds nothing the API and agent-e2e do not prove — cost if wrong: none.
Task 6: complete (commits 16e22ae..bfd209b, tests: turbo 97/98 then the reports race fixed (19/19 together), full api 256/256; repo 58/58; spectral; go; smoke 15/15; e2e 8 + automations; agent-e2e 6/6 incl. real helper restart; prod check OK)
Final review: self-review (no subagent without the user's request); no Critical or Important findings beyond the test race (fixed).
Final: minor (deferred): impact lists everything the host serves ("may interrupt … Redis, PostgreSQL") rather than what depends on the unit — unit-to-service mapping comes with M10 service identity.
Final: minor (deferred): the requester is not emailed when their action finishes (visible in the app and the audit log).
Final: minor (deferred): Cloudflare purge and GitHub dispatch execution paths wait for the M7 connections (adapters tested).
```

## Results

- **agent-e2e:**
  - `--enable-helper` installs `pcp-helper`: an active unit, a socket at 660 `root:pcp-agent`, and a root-owned key and allowlist.
  - A production restart of `demo.service` is refused for the requester (403), approved by a second admin, executed by the helper, and verified: `activeState=active`, and `ActiveEnterTimestamp` changed.
  - `ghost.service`, which is in the policy but not in the host allowlist, is refused by the helper.
- **Playwright:**
  - Policies are disabled by default, and Cloudflare and GitHub wait for their connections.
  - Enable, then propose with impact; the requester sees "Waiting for another approver".
- **Full pipeline:**

  | Stage | Result |
  |---|---|
  | turbo | 97/98; the reports test lost its queued jobs to the connections test's processors on the shared test Redis. Fixed, reproduced first (2 failed with both files together, then 19/19). |
  | API | 256/256 |
  | `test:repo` | 58/58 |
  | spectral, Go | pass |
  | smoke | 15/15 |
  | agent-e2e | 6/6 |
  | e2e | 8 passed, then automations after two test fixes |

- **Production check:**
  - A local systemd host installed from production with `--enable-helper` (agent 0.3.0, helper active, socket 660 `root:pcp-agent`).
  - A staging no-approval policy, then a proposal, which went to executing and then succeeded in 4 s, verified `active`.
  - The agent was revoked and the container removed afterwards.
- **Deploy:**
  - A `pg_dump` was taken first, and the env was backed up.
  - The 5 superseded images were removed by ID, and the disk is back at 89 %.
  - All 22 nginx sites answered the same before and after.
- **Interruption:** the Mac's battery ran out during the pipeline. The scratchpad tooling was recreated and the remaining checks were rerun.
