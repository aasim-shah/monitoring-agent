# Handoff — M6b services UI and charts

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-23 |
| **Branch** | `feat/m6b-services` |
| **Plan** | M6b plan Task 5 |
| **Workbooks** | WB-11 §4–§7, BR-11-01, BR-11-03 |

## Delivered

**API** (`apps/api/src/modules/telemetry`)

- `GET /api/v1/agents/:id/services/:packId/metrics?range=…` requires `telemetry.query`. It returns 404 when the pack is not enabled on the agent or is unknown, and 400 for a bad range.
- `service-metrics.ts` holds fixed PromQL per pack, for these charts:

| Pack | Charts |
|---|---|
| Redis | memory, commands/s, connected clients, hit ratio |
| PostgreSQL | connections, commits/s, size per database |
| MySQL | connected threads, operations/s |
| MongoDB | current connections, operations/s |
| nginx | requests/s, active connections |
| Kafka | lag per group, partitions |
| Node.js | CPU and memory per process, labelled `node (pid N)` |

- OpenAPI and the API client are updated.

**Web**

- `lib/seal.ts`: `sealCredentials(agentPublicKeyB64, fields)` uses WebCrypto ECIES and matches `control.OpenSealed`. The test opens both its own output and the shared vector that the Go agent opens.
- `components/services/services-panel.tsx`:
  - Lists detected and enabled services with their ports.
  - Shows an "Exposed to the internet on 0.0.0.0:5432" warning.
  - Shows status: Not monitored, Applying…, Monitoring, Failed (with the agent's message), Stopping….
  - Actions: Monitor / Change / Stop monitoring, plus "Monitor another service" for packs that were not detected.
  - Controls are hidden without `pack.manage`.
- `components/services/enable-pack-dialog.tsx`:
  - The endpoint is prefilled with the loopback default. Secret credential fields are password inputs, and required fields are checked.
  - Credentials are sealed before the request is built, so the request body never holds plaintext.
  - On an update, empty fields keep the credentials the agent already holds.
- `components/services/services-section.tsx` adds the "Services on this server" section on the host page:
  - pack status is polled every 5 s while a change is applying
  - each applied or pending pack gets its charts
- `lib/format.ts` gains the units `bytes`, `count`, and `perSecond`.
- Web `testTimeout` is 15 s: jsdom dialog tests slow down under parallel workers.

## Notes for Task 6

- Redis and PostgreSQL metric names are confirmed only by the e2e run; the other packs follow upstream metadata (see `service-metrics.ts`).

## Tests

- `pnpm --filter @pcp/web test`: 24 files, 89 passed.
- `pnpm --filter @pcp/api exec vitest run src/modules/telemetry`: 17 passed. The new tests cover:
  - Redis charts scoped to the tenant (a forged tenant is excluded)
  - per-process Node series
  - 404 for packs that are not enabled or unknown, 400 for a bad range
