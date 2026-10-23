# Handoff — M11.1 Live tail API (SSE) and log sources

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-23 |
| **Branch** | `feat/m11-logs` |
| **Plan** | M11 plan Task 3 |
| **Workbooks** | WB-12 UC-12-01 |

## Delivered

- **`GET /api/v1/agents/:id/log-sources`** (`agent.view`) returns `{ sources: [{ id, label }] }`. The list holds the sources of packs with status `applied`, then `host.journal`.
  - The table lives in `apps/api/src/modules/logs/sources.ts`. It mirrors the agent's `internal/logs/sources.go`.
  - Both tables are pinned to `packages/agent-protocol/testdata/log-sources.json`, by a Vitest test and a Go test.
- **`GET /api/v1/agents/:id/logs/tail?source=<id>`** (`logs.tail`) streams server-sent events.
  - **Before any byte is written:**
    - An unknown source, a pack that is not applied, or a path-like value gets `400 unknown_source`.
    - A viewer gets 404, like every missing permission.
    - Over the limit gets `429 too_many_streams`: 2 streams per agent, 5 per organization.
  - **Then:**
    1. The API subscribes to `stream:<session>`.
    2. It creates the signed `log_tail` task. The payload is `{ source, sessionId }`, the TTL and `maxRuntimeSeconds` are 900, and the scope is `{ agentId }`.
    3. The stream session is created in the same transaction as the task, before the agent is woken. So the agent's first chunk always finds the session.
  - **Events:**

    | Event | Data | When |
    |---|---|---|
    | `ready` | `{ sessionId, source }` | right after the headers |
    | `lines` | `{ sequence, lines }` | each non-empty agent chunk |
    | `end` | `{}`, or `{ reason: "expired" }` after 15 min | final chunk or successful task result |
    | `error` | `{ message }` | the task failed, e.g. the agent refused the source |

    A `: heartbeat` comment goes out every 15 s. The response sets `X-Accel-Buffering: no` and `Cache-Control: no-cache, no-transform` so proxies do not buffer it.
  - **Ending:** a closed connection, a final chunk, a task result, or the 15-minute timer closes the session and releases both limit slots. The agent's next chunk then gets 404 and it stops.
- **Limits** (`tail-limits.ts`): Redis sorted sets `logtail:tenant:<org>` and `logtail:agent:<agent>` hold session IDs scored by expiry. One Lua script drops expired entries, checks both counts, and reserves. Slots held by a crashed API instance free themselves at the 15-minute TTL.
- **Relay** (`stream-relay.ts`): one Redis subscriber per API process. Nothing is stored; lines exist only in pub/sub and the open response.
- **Task results:** `TasksService.onResult` publishes `{ type: "result", status, error }` for `log_tail` tasks on the stream channel. A refused source therefore reaches the viewer as an `error` event.
- **`TasksService`:** `NewTask.streamSessionId` (session in the same transaction) and `closeStream(ctx, sessionId)`.
- **Agent change:** `logs.Options.Idle` (default 5 s). A quiet source sends an empty chunk after 5 s idle, so the agent learns within seconds that the viewer left. Without it, a quiet tail held one of the host's 2 slots until the 15-minute TTL. The API does not forward empty chunks.
- **OpenAPI:** `listLogSources` added; `tailLogs` is now `text/event-stream` with 400/429 responses. The API client was regenerated.

## Tests

- `apps/api/src/modules/logs/logs.int.test.ts` (8 tests, a real listening server and `fetch`):
  - sources: applied packs only, journal last
  - a source-only payload, chunks relayed, `end` on the final chunk, session closed
  - a disconnect closes the session, a late chunk gets 404, slots are released
  - a failed task becomes an `error` event
  - `400` for `mysql.error` (pending), `kafka.server`, `/etc/shadow`, `../../etc/passwd`, and empty
  - a viewer gets 404 on tail but 200 on sources; an operator may tail
  - the 3rd stream per agent and the 6th per tenant get 429
  - slots held by a dead instance free after the TTL
- `sources.test.ts`, plus the Go test `TestSourcesMatchSharedFixture`, pin the fixture.
- The Go test `TestStreamStopsOnAQuietSourceWhenTheSessionCloses` covers the idle keepalive.
- The affected API suites (agents, connections: 75 tests) pass, as do the OpenAPI and api-client tests.

## Notes for next tasks

- **Task 5 (UI):** use `EventSource` with credentials from the same origin. Show "Waiting for the agent…" between `ready` and the first `lines`. Show "Stream ended" on `end` and the message on `error`. Close the `EventSource` on `end` or `error`, or it reconnects and opens a new stream.
- **Task 6 (deploy):** check that the production proxy path (nginx → Caddy → API) delivers events without buffering.
