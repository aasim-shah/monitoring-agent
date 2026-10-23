# Handoff — M11.1 Agent log tail and host redaction

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-23 |
| **Branch** | `feat/m11-logs` |
| **Plan** | M11 plan Tasks 1–2 |
| **Workbooks** | WB-12 UC-12-01/02 |

## Delivered

- **`internal/logs/redact.go`: `Redact(line)`**, applied on the host before any line leaves it:

  | Match | Replacement |
  |---|---|
  | `Authorization:` and `authorization=` values (Bearer, Basic, Token) | `[REDACTED]` |
  | URL passwords | `user:[REDACTED]@` |
  | JWTs | `[JWT]` |
  | GitHub, OpenAI, Stripe, Slack, AWS, and `pcp_enr_` tokens | `[TOKEN]` |
  | `password` / `secret` / `api_key` / `token` / `access_token` values | `[REDACTED]` (JSON-aware) |
  | Email addresses | `[EMAIL]` |
  | Luhn-valid 13–19 digit card numbers, including spaced or dashed | `[CARD]` |

  Lines are capped at 4 KB with a `…[truncated]` marker, and applying `Redact` twice changes nothing.
- **`internal/logs/sources.go`: the allowlist.** `Sources(appliedPacks)` returns the applied packs' sources plus `host.journal`:

  | Source | Read from |
  |---|---|
  | `redis.server` | Redis log file |
  | `postgresql.main` | PostgreSQL log file |
  | `mysql.error` | MySQL error log |
  | `mongodb.main` | MongoDB log file |
  | `kafka.server` | Kafka server log |
  | `nginx.access`, `nginx.error` | nginx log files |
  | `nodejs.journal` | journal, `_COMM=node` |

  - `Find` accepts IDs only and never a path.
  - `Resolve` uses the first existing path; globs are allowed.
  - `FilePaths(pack)` is used by the collector (Task 4).
- **`internal/logs/tail.go`: `Stream(ctx, src, send, Options)`**:
  - Reading starts at the end of the file.
  - **Rotation:** a new file at the path is reopened; truncation is detected when the file becomes shorter than what was read, like `tail -F`.
  - **Journal sources** use `journalctl -f -n 0 -o cat [match]`, run without a shell.
  - **Rate:** at most 200 lines/s, sent every 500 ms. The buffer holds at most 400 lines; excess lines are dropped and reported as `[pcp] dropped N lines`.
  - It stops when the context ends, the source fails, or the sender reports that the session closed.
- **`internal/logs/task.go`: `RunTask`** refuses sources outside the allowlist ("not allowed") and posts numbered chunks. It then sends a final chunk and returns `{ lines, ended }`.
- **Agent wiring:**
  - `control.Client.PostChunk`; a 404 means the session closed.
  - `log_tail` tasks run in goroutines, at most 2 at a time; a third is refused.
  - Each tail is bounded by the task's `maxRuntimeSeconds`, and its result is posted when it ends.
- **Installer.** `pcp-agent` joins `adm` and `systemd-journal` when those groups exist, for read access to logs only.

## Tests

`scripts/go.sh test ./agents/host-agent-go/...` passes. The logs tests are stable over 3 runs. They cover:
- the redaction corpus, ordinary numbers left alone, idempotence, and truncation
- appended lines arriving redacted, with no history sent
- the rate cap and drop marker
- rotation by rename and by truncate
- stopping when the session closes
- the allowlist, including `/etc/shadow` and traversal
- the journal arguments
- `Resolve` with globs
- `RunTask` refusals and the final chunk
- `PostChunk` reporting a closed session (404)
