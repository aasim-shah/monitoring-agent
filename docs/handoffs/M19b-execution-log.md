# Execution Log — M19b Self-hosted packaging, load baselines, documentation

| | |
|---|---|
| **Plan** | `docs/superpowers/plans/2026-10-25-m19-selfhosted.md` |
| **Branch** | `feat/m19-selfhosted` |
| **Executed** | 2026-10-25, inline, test-first. Final review was a self-review (no subagent). |
| **Deployed** | `https://monitor.aasimshah.com` (M18 and M19 together; migrations 0017, 0018; other VPS sites unchanged) |

## Ledger

```text
# SDD ledger — plan: docs/superpowers/plans/2026-10-25-m19-selfhosted.md
Spec: spec §19, §24; master plan M19.2, M19.4, M19.6; branch feat/m19-selfhosted stacked on feat/m18-logs-inspection.
Pre-flight: no shared interfaces between tasks.
Ruling: the external pentest (M19.1 part) and the pilot (M19.7) need people; documented, not done — cost if wrong: none.
Task 1: complete (commit 39c8283, tests: api identity 54/54 incl. oidc 4, ai 16/16 incl. ai-disabled, config; ai-orchestrator 21/21; worker report-handlers 17/17; web auth 6/6)
Task 2: complete (commit 272ce03, tests: repo 58/58)
Task 3: Ruling: load baselines run on the Mac (never the shared VPS): gateway write benchmark, in-process heartbeat run, k6 API reads through Caddy on a local stack; Caddy mTLS and storage costs are documented as not measured — cost if wrong: production edge cost unknown until measured on a separate host.
Task 3: results: gateway 206k samples/s per core (2.4 ms per 500 samples); heartbeats 663/s, p95 105 ms (≈19k agents per API process at 30 s); k6 API reads in capacity.md.
Task 4: board: M8/M9 task rows done; M6.3/M6.4 superseded by the agent control channel (aa993c9).
Task 5: deployed with M18 (see M18 log): OIDC routes live (404 until configured), /api/v1/auth/providers reports Google on, so the login page now shows "Continue with Google".
Final review: self-review (no subagent tool used).
Final: minor (deferred): ADR 0005 still describes OpAMP; amend it to the control channel that shipped.
Task 5: complete
```
