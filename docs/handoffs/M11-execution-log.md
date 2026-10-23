# Execution Log — M11 Logs (live tail, host redaction, log-derived metrics)

| | |
|---|---|
| **Plan** | `docs/superpowers/plans/2026-10-23-m11-logs.md` |
| **Branch** | `feat/m11-logs` (stacked on `feat/m9-discovery-graph`) |
| **Executed** | 2026-10-23, inline, test-first. Final review was a self-review (no subagent). |
| **Deployed** | `https://monitor.aasimshah.com` (api, web, downloads; no migration; other VPS sites unchanged) |

## Ledger

```text
# SDD ledger — plan: docs/superpowers/plans/2026-10-23-m11-logs.md
Spec: spec §11.8, §18.2; master plan M11.1–M11.2, §3 live tail limits; WB-12 UC-12-01..03; branch feat/m11-logs stacked on feat/m9-discovery-graph.
Pre-flight: T1 Redact consumed by T2 tail — consistent; T2 source IDs consumed by T3 API sources (shared JSON fixture) — consistent; T2 log_tail payload {source, sessionId} consumed by T3 task creation — consistent; T4 metric names consumed by T3/T5 chart templates — verify after the real collector run; T3 SSE events consumed by T5 viewer — consistent.
Ruling: SSE instead of WebSocket for the browser stream — one-way stream, works through nginx and Caddy without upgrade handling — cost if wrong: swap transport in one controller and one component.
Ruling: exit gate covers Redis + host journal on the systemd host; Kafka and Node.js sources pinned by unit tests (no Kafka/Node runtime in the e2e host) — cost if wrong: path mapping bug caught later.
Task 2: Ruling: truncation (copytruncate) is detected when the file is shorter than the read offset, like tail -F; a writer that outgrows the old size within one poll (250 ms) can lose the first lines — cost if wrong: a few lines missing right after rotation.
Task 2: complete (commits 268f94b..91ac24b, tests: scripts/go.sh test ./agents/host-agent-go/... → ok  	pcp.local/hostagent/internal/packs	(cached))
Task 1: complete (commits 268f94b..91ac24b, tests: scripts/go.sh test ./agents/host-agent-go/internal/logs/ -run Redact → ok  	pcp.local/hostagent/internal/logs	0.213s)
Task 3: Ruling: stream session is created inside the task-creation transaction (NewTask.streamSessionId) instead of openStream afterwards — the agent is woken at task creation and could post its first chunk before the session existed, get 404, and stop — cost if wrong: none known; openStream remains for other callers.
Task 3: Ruling: agent sends an empty chunk after 5 s idle (Options.Idle) — a quiet source never posted, so a closed viewer left the host's tail slot busy until the 15-min TTL (Review Focus #3) — cost if wrong: one tiny request per 5 s per open tail.
Task 3: Ruling: added a `ready` SSE event and an `error` event from the task result (onResult publish) — the viewer needs to tell "waiting for agent" and "agent refused" apart — cost if wrong: two extra event names for Task 5.
Task 3: complete (commits 91ac24b..457450b, tests: bash -c 'cd apps/api && npx vitest run src/modules/logs' →    Duration  17.74s (transform 892ms, setup 0ms, import 2.51s, tests 6.91s, environment 0ms))
Task 4: Ruling: added deltatocumulative processor (not in plan) — count connector emits delta sums and prometheusremotewrite drops non-cumulative sums — cost if wrong: one extra processor; e2e in Task 6 proves the series arrives.
Task 4: Ruling: chart "Log errors per minute" is `errors or all*0` — 0 when lines are counted without errors, gap when nothing is counted (no zeros without data) — cost if wrong: chart shows a gap instead of 0 on hosts whose logs are unreadable.
Task 5: Ruling: fetch streaming + own SSE parser instead of EventSource — EventSource cannot read 400/429 reasons and auto-reconnects (would open new tails) — cost if wrong: ~60 lines in lib/sse.ts.
Task 4: complete (commits 457450b..10a34e2, tests: scripts/go.sh test ./agents/host-agent-go/... → ok  	pcp.local/hostagent/internal/packs	13.268s)
Task 5: complete (commits 10a34e2..4e44d61, tests: bash -c 'cd apps/web && npx vitest run components/logs lib/sse components/services' →    Duration  2.50s (transform 391ms, setup 1.19s, import 790ms, tests 1.27s, environment 2.96s))
Final review: self-review (no subagent tool use without the user's request in this session)
Final: fixed early relay message written before SSE headers / writes after end / viewer gone during task creation keeps slots 15 min — sse-writer.test.ts (3 tests) RED→GREEN, logs suite 13/13
Final: minor (deferred): log-sources/tail are offered for private_worker agents too, which never run log_tail tasks (stream waits until TTL)
Final: minor (deferred): reopening a tail within ~5 s of closing can hit the agent's own 2-tail limit until the idle keepalive notices the closed session
Task 6: agent-e2e found: count connector emits only when lines arrive, so a 3-line error burst is one sample and rate() returns nothing (live tail parts of the gate passed).
Task 6: Ruling: replace deltatocumulative with count → loopback prometheus exporter (127.0.0.1:13134, metric_expiration 720h) scraped every 30 s by a prometheus receiver into the main pipeline — steady cumulative samples for sparse errors; loopback only keeps the no-external-listener rule — cost if wrong: two larger collector components (~binary size) and one loopback port.
Task 6: Ruling: chart uses MetricsQL increase_pure/5 instead of rate*60 — scraped counters first appear at their first-burst value, which rate drops (repro: rate 0, increase_pure 0.6/min for 3 errors) — cost if wrong: ties the template to VictoriaMetrics (already the only TSDB).
Note: branch history rewritten before first push (fake Stripe key literal in redact_test.go flagged by GitHub push protection); commit SHAs above for Tasks 1–5 and the final fix changed: 08e4f66, e26826b, 477c714, c4a9f81, bd31704. Backup: backup/m11-logs-before-rewrite.
Task 6: agent-e2e 5/5 pass after loopback-scrape fix (commit 1373623); exit gate green
```

## Results

- **Exit gate (agent end-to-end, systemd host):** all 5 scenarios pass.
  - A Redis log line with `password=hunter2` and an email arrives over SSE as `password=[REDACTED]` and `[EMAIL]`.
  - Closing the stream closes the session, and the agent's `log_tail` task ends as succeeded.
  - System journal lines are masked the same way.
  - Three Redis error lines show up in "Log errors per minute".
- **Found by the exit gate:** the count connector emits only when lines arrive, so a burst became one sample and the chart stayed empty. The counts now go through a loopback Prometheus exporter that is scraped every 30 s, and the chart uses `increase_pure`.
- **Found by self-review:** events could be written before the SSE headers, and a viewer who left during task creation held their slots until the TTL. Both are fixed (`SseWriter`).
- **Production check:** a test agent was installed with the production command on a local systemd host and the Redis pack enabled. Through nginx → Caddy → API, the tail returned `password=[REDACTED] by [EMAIL]`, and three error lines appeared in "Log errors per minute" within about a minute. The test agent was then revoked and the host removed.
- **Pipeline:** turbo lint/typecheck/test, `test:repo`, spectral, Go, smoke, and Playwright are green, plus agent-e2e 5/5.

## Deferred minors

- Log sources and live tail are offered for private-worker agents, which never run `log_tail`; such a stream waits until its TTL.
- Reopening a tail within about 5 s of closing can hit the agent's own 2-tail limit until the idle keepalive notices the closed session.

## How to resume

- **Using it.** On a server page, open **Logs**, then choose a source: each monitored pack's log, or System journal. Lines are masked on the host and nothing is stored. Each service with log files gets a "Log errors per minute" chart.
- **Agents** must be upgraded by re-running the install command, because the collector gained filelog, count, and Prometheus components.
- **Next.** M12 alerts and notifications (email through Resend, with the default error-spike rule on `log_lines_total`), then M14 AI (Gemini, with Groq as fallback). M7 is waiting for the GitHub OAuth app.
