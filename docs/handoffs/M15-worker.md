# Handoff — M15 Worker: dispatch, generate, deliver

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-24 |
| **Branch** | `feat/m15-reports` |
| **Plan** | M15 plan Task 3 |
| **Workbooks** | WB-15 UC-15-02/03/08/09, TC-15-03/04/07 |

## Delivered

- **`report-dispatcher.ts`:** every minute, due schedules are read as `pcp_scheduler`.
  1. `report-generate` is queued for the prior local day of the scheduled instant (job `report-generate__<org>__<schedule>__<localDate>`).
  2. The schedule then moves on with a compare-and-set.
  3. A missed day is caught up one run at a time.
- **`report-handlers.ts`:**
  - **Generate:**
    1. Checks that the schedule creator still has access to the product. If not, it returns `{ failed: 'not_found' }`.
    2. Builds the snapshot, narrates (respecting `ai_settings.disabled`), and marks `late` after 15 min.
    3. Creates the version and its deliveries in one transaction. A unique-key race reloads the winner.
    4. Queues only the unsent deliveries. A retry or restart never makes a second row.
  - **Deliver:**
    - Renders, then sends through `sendToChannel` (extracted from M12 incident delivery) or `sendMail` for direct recipients.
    - Retries 5 times, then dead. A deleted channel is dead at once.
- **`report-sources.ts`:**
  - Incidents and database health from PostgreSQL.
  - Host CPU, memory, and disk, log errors, and website uptime from VictoriaMetrics, using instant queries scoped by `extra_label=tenant_id` and the product filter.
  - Coverage per source.
- **AI providers:** `aiConfigFromEnv` and `providerFromConfig` now live in `@pcp/ai-orchestrator`, shared with the api. In the e2e stack, a scripted narrator cites `[S1]`.
- **Compose:** the worker gets `VM_QUERY_URL` and the `AI_*` keys. The e2e override sets `PCP_AI_FAKE=1`.

## Tests

- **Worker report tests** (9):
  - the dispatcher queues once and advances
  - 12 sections delivered to a channel and a recipient
  - TC-15-03 restart, TC-15-04 provider down, AI off, and TC-15-07 version 2
  - owner lost access, late runs, and retry then dead
- **Also:** the worker suite (27), notifications (10), config, and compose.
