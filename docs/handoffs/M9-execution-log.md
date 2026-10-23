# Execution Log — M9 Discovery, Graph, Topology

| | |
|---|---|
| **Plan** | `docs/superpowers/plans/2026-10-23-m9-discovery-graph.md` |
| **Branch** | `feat/m9-discovery-graph` (stacked on `feat/m8-private-worker`, with `feat/m8b-managed-databases` merged in) |
| **Executed** | 2026-10-23, inline, test-first. Interrupted once to ship managed databases (M8b) for the user's Atlas/Supabase. |
| **Deployed** | `https://monitor.aasimshah.com` (migration 0006; other VPS sites unchanged) |

## Ledger

```text
# SDD ledger — plan: docs/superpowers/plans/2026-10-23-m9-discovery-graph.md
Spec: spec §4.8, §6.5, §10, §15.4, §16.3, §21; master plan M9.1–M9.4, D3, D4, D7; WB-10; branch feat/m9-discovery-graph stacked on feat/m8-private-worker.
Pre-flight: T1 tables consumed by T2 engine — consistent; T2 ingestObservation/proposeEdge/completeRun consumed by T3 sources/rules — consistent; T3 assets+edges consumed by T4 API — consistent; T4 routes consumed by T5 UI — consistent; agents.last_seen_ip (T1) consumed by T3 dns-to-host — consistent.
Ruling: plan executed without user review — user asked to continue overnight — cost if wrong: re-plan.
Ruling: only rules with real data now (host-to-service, dns-to-host, name-similarity); provider rules land with their connectors (M7/M13) — cost if wrong: none (interface in place).
Task 1: Ruling: discovery_runs reuses the existing run_status enum (succeeded instead of completed) — one enum for runs — cost if wrong: none.
Task 1: complete (commits a66de57..07c0eba, tests: pnpm --filter @pcp/database test →    Duration  18.43s (transform 404ms, setup 0ms, import 4.52s, tests 75.27s, environment 1ms))
Task 2: Ruling: alias candidates only for host/website/domain/repository (and weak identities) — services like Redis repeat per host by design — cost if wrong: missed duplicate review for services.
Task 2: complete (commits 07c0eba..a1422af, tests: pnpm --filter @pcp/discovery-engine test →    Duration  7.42s (transform 223ms, setup 0ms, import 887ms, tests 6.38s, environment 0ms))
Task 3: Ruling: database→host edge type DEPLOYED_ON with rules db-on-host (IP 0.8) and name-similarity (0.3, only one same-engine service) — plan said CONNECTS_TO database↔service; DEPLOYED_ON says what the evidence shows — cost if wrong: an edge-type rename.
Task 3: Ruling: per-product pg_advisory_xact_lock around a run — a background run (inventory) and an on-demand run raced on asset creation (test caught it) — cost if wrong: none.
Task 3: Ruling: discovery after a validated private connection is not triggered directly; the next run (on demand or inventory) picks it up — cost if wrong: up to one inventory interval (5 min) delay.
Task 3: complete (commits a1422af..6452034, tests: bash -c 'cd apps/api && pnpm exec vitest run src/modules/agents src/modules/packs src/modules/connections src/modules/discovery' →    Duration  17.34s (transform 3.72s, setup 0ms, import 41.54s, tests 39.92s, environment 3ms))
Task 4: Ruling: manual asset/edge routes are POST /products/:productId/assets and POST /assets/:id/relationships (spec lists POST /assets, POST /relationships) — TenantGuard needs a route parameter — cost if wrong: two route aliases later.
Task 4: Ruling: product scope for assets enforced in the service (guard resolves organization only) — assets belong to several products — cost if wrong: none (tests pin scope).
Task 4: Ruling: merge retires the newer asset with mergedInto; the engine redirects that identity — keeps history and stops resurrection by discovery — cost if wrong: none.
Task 4: Ruling: interrupted mid-task for managed databases (user need); built on feat/m8b-managed-databases from the deployed M8 state, deployed, merged back into this branch — cost if wrong: none.
Task 4: complete (commits 6452034..a05e6fb, tests: bash -c 'cd apps/api && pnpm exec vitest run src/modules/assets src/modules/discovery && cd ../../ && pnpm --filter @pcp/discovery-engine test' →    Duration  6.67s (transform 222ms, setup 0ms, import 933ms, tests 5.62s, environment 0ms))
Task 5: complete (commits a05e6fb..a55cd32, tests: bash -c 'cd apps/web && pnpm exec vitest run components/assets lib/nav' →    Duration  1.53s (transform 175ms, setup 497ms, import 297ms, tests 263ms, environment 649ms))
Task 6: Ruling: Playwright seeds the graph with SQL (docker exec psql) rather than a live agent — the agent path is covered by agent-e2e and discovery tests; this gate checks the review UI and counts — cost if wrong: none.
Task 6: complete (commits a55cd32..7631b88, tests: turbo 74/74 (api 199, web 107, database 82, discovery-engine 9, connector-runtime 18, jobs 6, connectors-databases 22); repo 51; go ok; smoke 15; Playwright 4 (incl. M9 exit gate); agent-e2e 4; production: migration 0006 applied, discovery run 200, assets/coverage served, other VPS sites unchanged)
Final review: self-review (session policy). Checked: scope filter applied inside the impact CTE and on every route; edges need both ends visible; tenant resolver functions SECURITY DEFINER with membership join; discovery runs serialized; merge never deletes evidence; redaction before storage.
Final: minor (deferred): no product edit route, so domains (for dns-to-host) are set only at product creation.
Final: minor (deferred): provider rules (repo-to-service, prometheus-target, website-to-api, app-to-analytics) land with M7/M13 connectors; service-connections needs agent TCP evidence.
Final: minor (deferred): impact 'confirmed' uses health checks until incidents exist (M12).
Final: minor (deferred): topology has no clustering for >2,000 assets (pagination by product/environment only).
```

## Results

- **Exit gate (Playwright):** a FireMaps-like graph goes through the review queue. One edge is confirmed and one rejected; the topology then shows 4 nodes and 3 edges, and the coverage counts match. Both actions are audited.
- **Review Focus #1:** a member scoped to Product B sees the shared host and B's assets only. Assets, edges, topology, and impact show no FireMaps names, IDs, or counts.
- **Production:** discovery runs, and assets and coverage are served for the test product.

## How to resume

- **Using it.** Assets → Run discovery. Hosts, services, databases (worker or managed), and the product's domains appear; review proposed links in the Review tab.
- **Next.** M11 logs, M12 alerts and notifications (email through Resend), M14 AI (Gemini, with Groq as fallback). M7 is waiting for the GitHub OAuth app.
