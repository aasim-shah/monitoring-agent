# Handoff — M6b agent discovery

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-22 |
| **Branch** | `feat/m6b-services` |
| **Plan** | M6b plan Task 2 |
| **Workbooks** | WB-11 §3 (discovery), BR-11-02 |

## Delivered

- `packages/agent-protocol/schemas/inventory.schema.json`: the inventory message (`collectedAt`, `services`, `listeners`, `warnings`) with item caps. Generated TypeScript and Go types; `inventory` added to `MESSAGE_KINDS`.
- `agents/host-agent-go/internal/discovery`:
  - `Scan(fsys fs.FS, now time.Time) (Inventory, error)` over a procfs-shaped file system (`os.DirFS("/proc")` on a host).
  - Reads only `net/tcp`, `net/tcp6`, `<pid>/comm`, and `<pid>/cmdline`. It never opens `environ`; a test wrapper fails the test if it tries.
  - Caps: 2,000 processes, 500 listeners, 4 KB per file read, and the schema's limits for services, ports, evidence, and warnings.
  - The catalog detects redis, postgresql, mysql/mariadb, mongodb, kafka (`java` with `kafka.Kafka` in the command line), nginx, and nodejs (`node`, `PM2`). A service is detected by its process; its ports are the listeners on the pack's default ports.
  - Sensitive packs (redis, postgresql, mysql, mongodb, kafka) bound to a non-loopback address produce an `exposed_service` warning.
- `control.Client.PostInventory` posts to `POST /agent/v1/inventory`. `pcp-agentctl run` posts at start and every 5 minutes.
- The run loop now keeps the control client in an `atomic.Pointer`. Before, certificate rotation reassigned the client while the heartbeat goroutine read it (a data race).

## Notes for Task 3

- The API endpoint `POST /agent/v1/inventory` does not exist yet. Until Task 3 lands, the agent logs one `inventory:` error every 5 minutes.
- A service whose process is visible but which listens on a non-default port has no ports listed. Mapping sockets to processes needs `/proc/<pid>/fd`, which we do not read.

## Tests

`scripts/go.sh test ./agents/host-agent-go/...` passes: discovery fixtures (redis on loopback, postgres on 0.0.0.0 with a warning, kafka by command line, node processes counted, IPv6 `::1`, malformed lines, unreadable process, caps) and `TestPostInventory`. `pnpm --filter @pcp/agent-protocol test` → 10 passed.
