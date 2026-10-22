# Execution Log — M6a Host Metrics Path

| | |
|---|---|
| **Plan** | `docs/superpowers/plans/2026-10-22-m6a-host-metrics.md` |
| **Branch** | `feat/m6-host-agent` (stacked on `feat/m5-onboarding-agents`) |
| **Executed** | 2026-10-22, inline, test-first |

## Ledger

```text
# SDD ledger — plan: docs/superpowers/plans/2026-10-22-m6a-host-metrics.md
Spec: spec §8.5–8.7, §11, §16.2, §17; master plan M6, D12, D15, D16, D22; WB-04, WB-05; branch feat/m6-host-agent stacked on feat/m5-onboarding-agents.
Pre-flight: T1 internal lookup consumed by T2 gateway — consistent; T2 label names (tenant_id, product_id, environment_id, agent_id) consumed by T3 queries — consistent; T4 collector config/metric names consumed by T3 PromQL templates and T5 installer — consistent (hostmetrics via prometheusremotewrite → system_cpu_time_seconds_total etc.; verify names in T4 and adjust T3 templates); T3 endpoints consumed by T6 UI — consistent; T5 harness consumed by T6 Playwright — consistent.
Ruling: M6 split into M6a (metrics path) and M6b (OpAMP, discovery, OTLP logs, OS matrix, size budgets) — the user's priority is seeing server metrics end to end — cost if wrong: M6b reworks agentctl supervision into opampsupervisor.
Ruling: collector built with ocb v0.162.0 in a Go 1.26 image (upstream requires Go 1.26); our own Go code stays on 1.23 (ADR 0002) — cost if wrong: one ADR amendment.
Ruling: remote_write only in M6a; OTLP endpoints 501 — cost if wrong: none (BR-04-01 satisfied when M6b adds OTLP).
Ruling: pcp-agentctl supervises the collector directly until M6b brings opampsupervisor (D12) — cost if wrong: rework of run loop in M6b.
Task 1: Ruling: fixed M4 credential-storage race here (Prisma upsert → INSERT ... ON CONFLICT) — the M5 open observation reproduced in this task's full run with 'Unique constraint failed' on connectionSecret.upsert — cost if wrong: none
Task 1: complete (commits 65af2bb..ed9007c, tests: pnpm turbo run test --filter @pcp/api --filter @pcp/connector-runtime →   Time:    26.866s )
Task 2: complete (commits ed9007c..2125e78, tests: scripts/go.sh test ./apps/ingest-gateway/... → ok  	pcp.local/ingestgateway	(cached))
Task 4: Ruling: Task 4 done before Task 3 — query templates need the collector's real metric names (recorded in M6.1 handoff) — cost if wrong: none
Task 4: Ruling: prometheus receiver left out of the M6a collector build (it pulls in Prometheus and is only needed for service exporters, M11 packs) — cost if wrong: one builder line in M11
Task 4: complete (commits 2125e78..88b3993, tests: scripts/go.sh test ./agents/host-agent-go/... → ok  	pcp.local/hostagent/internal/control	(cached))
Task 3: complete (commits 88b3993..b951160, tests: pnpm --filter @pcp/api test →    Duration  29.86s (transform 3.66s, setup 0ms, import 88.26s, tests 116.43s, environment 6ms))
Task 5: Ruling: install command carries --download-url (no server-side templating of install.sh) — explicit and testable — cost if wrong: none
Task 5: Ruling: VictoriaMetrics -search.latencyOffset=5s (first measured install-to-visible time 81 s against the 60 s target) — remote_write arrives in order per series — cost if wrong: occasional partial last point
Task 5: complete (commits b951160..HEAD, tests: pnpm test:agent-e2e → 2 passed; metrics visible 81s before latency change)
Task 6: Ruling: Playwright chart spec deferred to M6b (e2e stack has no collector host); data path proven by test:agent-e2e, page by component tests + dev-stack browser journey — cost if wrong: a chart regression not caught in CI until M6b
Task 6: complete (commits 86aec1c..fd22739, tests: pnpm --filter @pcp/web test →    Duration  6.23s (transform 1.10s, setup 12.71s, import 5.85s, tests 7.55s, environment 26.49s))
Task 7: complete (tests: turbo lint/typecheck/test 59/59 (api 158, web 78, database 61); test:repo 51; go test + vet ok; smoke 15; Playwright 3; agent-e2e 2 incl. installer; metrics visible 77 s after install start)
Final review: self-review (session policy: no subagents unless the user asks); fixes during tasks: credential storage race (row lock), unaligned query grid (all-null points), range end cut-off, Go Dockerfiles missing go.work module, dist/ excluded by .dockerignore (renamed release/), isolated points invisible on charts
Final: minor (deferred): install-to-visible is 77 s (includes ~30 MB download and enroll; CPU utilization needs two 30 s scrapes); consider a 15 s first-minute interval in M6b.
Final: minor (deferred): filesystem metrics absent in containers (collector sees container root); real hosts fine; add root_path for container installs in M6b.
Final: minor (deferred): product switcher briefly shows "All products" while a product page loads.
Final: minor (deferred): Playwright spec for charts needs a collector host in the e2e stack (M6b).
```

## Results

- Exit gate: on an Ubuntu 24.04 systemd host, `curl … /install.sh | bash` verifies checksums, enrolls, starts `pcp-agent`, and host CPU/memory/network appear in the dashboard API 77 s after the install starts, with no inbound port opened (`pnpm test:agent-e2e`).
- Browser check on the dev stack: the Infrastructure list and host charts render live data from a real installed host.
- Full pipeline green (see Task 7 line).

## How to resume

- Next: M6b (OpAMP server/supervisor, `pcpcontrol` discovery of services such as Redis/Kafka/Node, OTLP logs, D22 OS matrix, size/RSS budget, faster first sample), then M7 integrations.
- Local: `scripts/dev-host.sh <token>` attaches a real installed host; deploy guide `docs/runbooks/deploy-control-plane.md`.
