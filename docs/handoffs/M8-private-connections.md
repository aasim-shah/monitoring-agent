# Handoff — M8 control plane for private connections

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-23 |
| **Branch** | `feat/m8-private-worker` |
| **Plan** | M8 plan Task 5 |
| **Workbooks** | WB-07 UC-07-02..06, BR-07-01/05/07 |

## Delivered

- **Registry.** The production connector registry now contains `postgres`, `mysql`, `mongodb`, and `custom-http`. They appear in `GET /api/v1/connectors/catalog`.
- **Creating a private connection** (`executionLocation: 'private'`). `config` must hold:
  - `workerAgentId`: an **active `private_worker` of the same organization**
  - `secretRef`: a simple name (BR-07-07)

  Any credential-like key (`password`, `token`, `apiKey`, `uri`, …) is rejected (BR-07-01). The connection starts in `pending_validation`, and a signed `connector_op` validate task is queued for the worker. `allowInsecure` is recorded in the audit event.
- **Endpoints.**
  - `POST /connections/:id/authorize` on a private connection returns 400 `credentials_local`.
  - `POST /connections/:id/validate` dispatches a validate task to the worker. Discover is unsupported for private connections.
- **`PrivateOpsService`** hooks into `TasksService` (`onPoll`, `onResult`):
  - **Due health checks.** When a private worker polls, a health task is queued for each of its connected or degraded connections whose last health check is older than 5 minutes and that has no pending task. The control plane needs no scheduler.
  - **Results.** A result is applied only if it comes from the connection's own worker (`config.workerAgentId === agent.id`).
    - A successful validate moves the connection to `connected` with `lastValidatedAt` set and immediately queues a health check.
    - A failed validate moves it to `degraded` with `statusReason` = the worker's reason (`permission_denied`, `authentication_failed`, `network_unreachable`, `tls_unavailable`, …).
    - Each health result writes a `connection_health` row whose `detail` is the JSON data (at most 256 KB). A failed check degrades a connected connection, and a healthy check recovers it unless the reason was `permission_denied`.
- **Worker offline.** At read time, `GET /connections/:id` and the list show `degraded / worker_offline` whenever the worker is degraded, stale, or revoked.
- **New routes:**

| Route | Permission | Behavior |
|---|---|---|
| `GET /api/v1/connections/:id/health` | `connection.view` | `{ latest, history (10), lastTemplate }` |
| `POST /api/v1/connections/:id/write-override` | `connection.configure` | Sets `writeOverrideAcknowledged`, audits `connection.write_override`, and revalidates. Returns 202 `{ taskId }`. |
| `POST /api/v1/connections/:id/templates/:name/run` | `connection.configure` | Accepts only the provider's named templates (400 otherwise). Body `{ from, to }`. Returns 202 `{ taskId }`. |

- **Install command.** Enrollments with `agentType: private_worker` return `curl …/downloads/pcp-private-worker.tar.gz | docker load && docker run … pcp-private-worker:0.1.0 enroll-and-run --token … --control-url …`.
- **Truncation flag.** The worker now sends its `truncated` flag inside `result`.
- **Docs.** OpenAPI updated and the API client regenerated.

## Notes for Task 6/7

- The `downloads/pcp-private-worker.tar.gz` file has to be published by the deploy (Task 7).
- Template results come from the latest successful `connector_op` template task (`agent_task_results`); there is no separate table.

## Tests

- `pnpm --filter @pcp/api exec vitest run src/modules/agents src/modules/connections`: 70 passed. The new `private-ops.int.test.ts` (7 tests) covers:
  - the catalog
  - a worker from another organization, a host agent, a `../` `secretRef`, and a password in config all give 400
  - signed validate task → connected → health row; no `connection_secrets` row
  - `permission_denied`, then an audited override, then revalidation
  - `worker_offline`
  - due health checks created on poll without duplicates
  - templates: an unknown name gives 400, a viewer gets 404, the last result is shown
- Enrollment test for the private-worker install command.
- `@pcp/connector-runtime`: 16 passed.
