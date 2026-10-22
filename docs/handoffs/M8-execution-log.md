# Execution Log — M8 Private Connector Worker, Databases, Custom REST

| | |
|---|---|
| **Plan** | `docs/superpowers/plans/2026-10-23-m8-private-worker-databases.md` |
| **Branch** | `feat/m8-private-worker` (stacked on `feat/m6b-services`) |
| **Executed** | 2026-10-23, inline, test-first (user asleep; plan executed without review on request) |
| **Deployed** | `https://monitor.aasimshah.com` (shared VPS, other sites unchanged) |

## Ledger

```text
# SDD ledger — plan: docs/superpowers/plans/2026-10-23-m8-private-worker-databases.md
Spec: spec §4.6, §7.3, §7.6, §18.1; master plan M8.1–M8.3, §3 limits; WB-07, WB-03; branch feat/m8-private-worker stacked on feat/m6b-services.
Pre-flight: T1 guard consumed by T3 custom-http — consistent (createHttpClient destination option); T2 connectors + runTemplate consumed by T4 worker registry and T5 template route — consistent; T4 connector_op payload {connectionId, provider, operation, config, template?, params?} consumed by T5 task creation/result hook — consistent; T5 endpoints consumed by T6 UI — consistent; T4 docker image consumed by T5 install command and T7 e2e — consistent.
Ruling: plan written and executed without user review — user asked to continue overnight (2026-10-23) — cost if wrong: re-plan of M8 scope.
Ruling: health tasks created lazily when a private worker polls (no API scheduler) — prod runs no BullMQ worker; one code path — cost if wrong: health stops while the worker is offline (which is the desired signal).
Task 1: complete (commits e615569..d4af5a0, tests: pnpm --filter @pcp/connector-sdk test →    Duration  622ms (transform 355ms, setup 0ms, import 1.49s, tests 128ms, environment 1ms))
Task 2: Ruling: one package @pcp/connectors-databases with three connectors (plan named three packages) — shared config/error/cap code, one Testcontainers setup — cost if wrong: a later split is a move.
Task 2: Ruling: the MySQL test and implementation were written together; a mutation (disabling the write check) turned the test red, so the test is proven to pin the check — cost if wrong: none.
Task 2: Ruling: added ConnectorErrorReason authentication_failed/network_unreachable/tls_unavailable (WB-07 §8 asks to distinguish them) — cost if wrong: none.
Task 2: complete (commits d4af5a0..4781430, tests: bash -c 'pnpm --filter @pcp/connector-sdk test && pnpm --filter @pcp/connectors-databases test' →    Duration  14.86s (transform 351ms, setup 0ms, import 2.32s, tests 30.13s, environment 0ms))
Task 3: Ruling: custom REST returns extracted values via health().data (not collect: MetricQuery is PromQL-shaped) — KPI storage is M13 — cost if wrong: a later adapter to collect.
Task 3: complete (commits 4781430..89ff95c, tests: pnpm --filter @pcp/connectors-custom-http test →    Duration  462ms (transform 101ms, setup 0ms, import 221ms, tests 62ms, environment 0ms))
Task 4: complete (commits 89ff95c..f164011, tests: pnpm --filter @pcp/private-connector-worker test →    Duration  710ms (transform 124ms, setup 0ms, import 451ms, tests 38ms, environment 0ms))
Task 5: Ruling: template results read from agent_task_results (no new table) — the worker's result is already stored there, tenant-scoped — cost if wrong: a query over task payloads.
Task 5: Ruling: TasksService gains onPoll/onResult hooks instead of a forwardRef between agents and connections modules — cost if wrong: none.
Task 5: Ruling: worker image is distributed as downloads/pcp-private-worker.tar.gz + docker load (no registry yet) — cost if wrong: a registry later changes only the install command.
Task 5: complete (commits f164011..b87c316, tests: bash -c 'cd apps/api && pnpm exec vitest run src/modules/agents src/modules/connections' →    Duration  16.58s (transform 3.20s, setup 0ms, import 39.46s, tests 24.37s, environment 2ms))
Task 6: complete (commits b87c316..0589b06, tests: bash -c 'cd apps/web && pnpm exec vitest run components/databases lib/nav && cd ../api && pnpm exec vitest run src/modules/agents/fleet' →    Duration  10.28s (transform 811ms, setup 0ms, import 2.47s, tests 1.74s, environment 0ms))
Task 7: Ruling: worker image served from /opt/pcp/worker-image mounted into the downloads container at /srv/downloads/worker (compose.vps.yaml) — no registry, no rebuild of the downloads image — cost if wrong: a registry later changes the install command only.
Task 7: Ruling: added --hostname "$(hostname)" to the worker install command after the prod check showed the container ID as the worker name — enrollment test RED→GREEN — cost if wrong: none.
Task 7: complete (commits 0589b06..cff4fb4, tests: agent-e2e 4 passed incl. M8 gate (MongoDB health via worker; pg_dump has no password); full pipeline turbo 70/70 (api 184, web 97, database 66, connector-sdk 55, connectors-databases 17, private-worker 13, custom-http 7), repo 51, go ok, smoke 15, Playwright 3; production: worker enrolled via 8443, MongoDB connected + health in 4 s, Databases page renders, other VPS sites unchanged)
Final review: self-review (session policy). Checked: no credential path into the control plane (create rejects secret-like keys; authorize refuses private; e2e pg_dump); results applied only from the connection's own worker; templates are named and guarded plus read-only sessions; SSRF guard pins the vetted address; worker drops forged/expired tasks; secretRef cannot traverse.
Final: minor (deferred): health tasks are created lazily on poll; two concurrent polls from the same worker could queue a duplicate health task (harmless; the next result overwrites).
Final: minor (deferred): custom REST has no UI yet (API/connector only); the Integrations page (M7) will host it.
Final: minor (deferred): template results are not stored as KPIs yet (M13).
Final: minor (deferred): prod test data added: org "M6b prod check" now also has a revoked private worker and a "FireMaps (prod check)" MongoDB connection (shows worker_offline).
```

## Results

- **Exit gate** (`pnpm test:agent-e2e`, 4 passed):
  1. A private worker container enrolls through Caddy mTLS.
  2. It validates a FireMaps-like MongoDB with a `read` + `clusterMonitor` user, using credentials from its local secret file.
  3. It reports `serverStatus`/`dbStats` health.
  4. A `pg_dump` of the control-plane database contains the `secretRef` but never the password.
- **Production:**
  - A worker installed from the production command (`curl …/downloads/worker/pcp-private-worker.tar.gz | docker load && docker run …`) enrolled over port 8443.
  - The MongoDB connection was connected, with health, 4 s after creation.
  - The Databases page shows the worker as Active and the database as Connected, with connections and size.

## How to resume

- **Using it for real.** On a server that can reach your databases:
  1. Databases → Add private worker → run the command.
  2. Create a read-only user (the dialog shows the commands) and write `/etc/pcp-worker/secrets/<name>.yaml`.
  3. Add database.
- **Next.** M9 (discovery graph, topology), M11 (logs), M12 (alerts and notifications through Resend), M14 (AI with Gemini, Groq as fallback). M7 is waiting for the GitHub OAuth app. M13 can start, since the Google client exists.
