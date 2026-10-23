# Handoff — M11.2 Log-derived metrics

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-23 |
| **Branch** | `feat/m11-logs` |
| **Plan** | M11 plan Task 4 |
| **Workbooks** | WB-12 UC-12-03 |

## Delivered

- **The collector counts log lines; it never ships them.** Each applied pack with log files gets a `filelog/<pack>` receiver:
  - **`include`:** the pack's paths from the agent allowlist, via `logs.FilePaths` passed in as `collector.Input.LogFiles`.
  - **`start_at: end`**, with no file names.
  - **Operators**, in order:
    1. `service = <pack>`.
    2. A router sets `level`:

       | Level | Matches |
       |---|---|
       | `error` | `error`, `err`, `fatal`, `crit`, `critical`, `panic`, `emerg`, `severe` (whole words, any case), MongoDB `"s":"E"`/`"F"`, and for nginx a 5xx status in an access line |
       | `warn` | `warn` / `warning`, MongoDB `"s":"W"` |
       | `info` | everything else |

    3. A second router sets `pattern = oom` for `out of memory`, `oom-killer`, or `OOMKilled`, and `pattern = stacktrace` for lines starting with whitespace then `at `, or with `Traceback`.
- **Pipelines.**
  - **logs:** `filelog/*` → `memory_limiter` → `count`.
  - **count connector:** `log.lines{service,level}` and `log.pattern{service,pattern}`; the second counts only lines where `pattern` is set.
  - **metrics/logcounts:** `count` → `prometheus/logcounts`, a Prometheus exporter on `127.0.0.1:13134` (loopback only) that keeps the running totals for 720 h.
  - **metrics:** a `prometheus/logcounts` receiver scrapes that exporter every 30 s. The allowlist keeps exactly `log_lines_total` and `log_pattern_total` and drops the scrape's own `up` and `scrape_*` series.
  - **Why the loop:** the count connector emits only when lines arrive. Sent straight to remote_write, a burst of 3 errors became one sample, and the chart showed nothing (found by the agent end-to-end test). The scrape turns it into a steady counter.
  - **No log files:** without packs that have log files, there is no logs pipeline, connector, exporter, or scrape (the Node.js pack uses the journal).
- **Stored names:** `log_lines_total` and `log_pattern_total`, with labels `service`, `level` or `pattern`, plus `job="pcp-log-counts"`.
- **Collector build:** `filelogreceiver`, `countconnector`, `prometheusexporter`, and `prometheusreceiver` v0.162.0 were added to `collector/builder-config.yaml`. The downloads image changes, and agents upgrade by re-running the installer.
- **Charts:** every pack with log files (Redis, PostgreSQL, MySQL, MongoDB, Kafka, nginx) gains "Log errors per minute":

  `(sum(increase_pure({__name__=~"log_lines(_total)?",service="<pack>",level="error"}[5m])) / 5) or (sum(increase_pure(…all levels…[5m])) * 0)`

  - **Why `increase_pure`:** a counter first appears when its first lines arrive, already at their count. `rate` would drop that first burst; MetricsQL `increase_pure` counts from 0.
  - The chart shows 0 while lines are counted but none are errors. It shows a gap when nothing is counted, so it never draws zeros without data.

## Tests

- `internal/collector/logs_test.go`:
  - the Redis and nginx receivers, operators, and route regexps against real Redis, PostgreSQL, MySQL, MongoDB, nginx, Node.js, and Python lines
  - the connector definitions, both pipelines, and the allowlist
  - no logs pipeline without log files
- `TestRealCollectorAcceptsEveryPack` now runs with `LogFiles` set, so the built collector validates every pack with the log pipeline.
- `service-metrics.int.test.ts` covers:
  - the template for each pack
  - 2 errors per minute in steady state
  - a new counter's first burst (appearing at 3) charted above 0
- Locally, the real collector, a log file, and VictoriaMetrics give `log_lines_total{level="error"}` = 3 every 30 s after 3 error lines.

## Notes

- Without the storage extension, offsets reset when the collector restarts, and `start_at: end` skips lines written while it was down. This is acceptable for counts.
- `pcp-agent` reads log files through the `adm` group (installer, Task 2). Files readable only by root are not counted.
