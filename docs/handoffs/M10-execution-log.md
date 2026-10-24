# Execution Log — M10 Monitoring Packs (remainder)

| | |
|---|---|
| **Plan** | `docs/superpowers/plans/2026-10-25-m10-packs-remainder.md` |
| **Branch** | `feat/m10-packs` (stacked on `feat/m19-hardening`); deployed from `feat/m15b-report-trends`, which contains it |
| **Executed** | 2026-10-24, inline, test-first. Final review was a self-review (no subagent). |
| **Deployed** | `https://monitor.aasimshah.com` (migration 0015; migrate, api, web, worker, ingest-gateway, downloads with agent 0.4.0; other VPS sites unchanged) |

M10.1–M10.4 and M10.8 shipped in M6b; this closes M10.5 (Level 2 guides), M10.6 (usage and limits), M10.7 (live boost), and the drop-label transform (BR-11-06).

## Ledger

```text
# SDD ledger — plan: docs/superpowers/plans/2026-10-25-m10-packs-remainder.md
Spec: spec §8.8–§8.10, §11.6; master plan M10.5–M10.7; WB-11; branch feat/m10-packs stacked on feat/m19-hardening.
Pre-flight: T2 usage table consumed by T2 web only; T3 boost task type consumed by the agent in T3 — consistent; T1 independent.
Ruling: ingest limits already refuse new series (M6.5); M10.6 adds visibility and notice, not a second limiter — cost if wrong: none.
Ruling: live charts poll every 5 s instead of the planned SSE /assets/:id/live — same freshness, no new stream type — cost if wrong: one SSE endpoint later.
Task 1: Ruling: validated with otel/opentelemetry-collector-contrib:0.162.0 'validate' (same version as pcp-otelcol) instead of building pcp-otelcol — the agent-e2e run exercises pcp-otelcol itself — cost if wrong: caught by agent-e2e.
Task 1: complete (commit 50c464e, tests: go collector ok incl. TestEveryConfigDropsHighCardinalityLabels; contrib 0.162.0 validate exit 0)
Task 2: Ruling: limits shown in the API are the gateway's constants (20k series per agent, 200k per tenant, 10k samples/s per agent), not per-plan settings — no plans exist yet — cost if wrong: one setting when plans arrive.
Task 2: complete (commit 7d7f74f, tests: go ingest-gateway ok incl. usage 2; database usage-boosts+rls+drift 122/122; api usage 4/4, tenants 17/17; web usage+nav 6/6; openapi 4/4)
Task 3: Ruling: boosts live in agent memory, so an agent restart ends them (never stuck at 5 s); the API may show a boost a few minutes longer than it ran — cost if wrong: a stale 'Live' label after a restart.
Task 3: Ruling: agent bumped to 0.4.0 (live_boost handling); boosts need 0.4.0 — cost if wrong: none.
Task 3: complete (commit 067aedf, tests: go packs+collector ok incl. boost 2; api packs 14/14 incl. live-boost 3; web services 10/10; openapi 4/4)
Task 4: Ruling: guides for nodejs, kafka, nginx only (the spec's three Level 2 examples); other packs are Level 0 — cost if wrong: more guides later.
Task 4: complete (commits de07b1a..1fe4480, tests: go agent all ok + contrib validate exit 0; api telemetry+packs 35/35 incl. pack-verification 2; web services 13/13; openapi 4/4)
Task 5: fixed: time-bomb test clocks (actions froze at 2026-10-24T10:00Z, failing after 11:00Z; usage pinned a future date) — now relative to real time; actions+usage 18/18.
Task 5: fixed: pcp-otelcol lacked the transform processor and the OTLP receiver, so the agent's collector refused every config (agent-e2e: 'transform' unknown type) — builder_test.go TestEveryComponentIsInTheCollectorBuild RED→GREEN; Task 1's contrib-only validation ruling cost exactly this.
Task 5: pipeline (run on feat/m15b-report-trends, which contains M10): build, lint, typecheck, turbo test, repo, openapi, audit:prod, go test+vet, Playwright 11/11, agent-e2e 6/6; format fixed in 7991f65; smoke 30/30 after a warm cache (first run timed out at 900 s on a cold cache).
Task 5: deployed 2026-10-24 together with M15b: migration 0015; migrate, api, web, worker, ingest-gateway, downloads (agent 0.4.0 with otlp + transform); pg_dump pre-m10-m15b taken; images shipped in two batches (VPS at 90 % disk) and api/web by resumable rsync after ssh drops; superseded images removed by ID; 22 sites unchanged.
Task 5: production check: agent 0.4.0 tarball served (200); usage API refuses unauthenticated (401); all pcp services healthy. A live boost on a real agent needs the owner's agent upgraded to 0.4.0 (re-run the installer).
Final review: self-review (no subagent tool used).
Final: minor (deferred): boosts live in agent memory; an agent restart ends a boost while the API may still show it for up to 10 minutes.
Task 5: complete
```

## Upgrading agents

Existing agents keep their collector until the installer is re-run. Live boost and the Node.js Level 2 OTLP receiver need agent 0.4.0.
