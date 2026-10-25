# Capacity baselines (M19.2)

Measured, not promised: no numeric SLO is published until production baselines exist (spec §19.2). Re-run these on your own hardware before sizing a deployment.

**Reference machine:** MacBook Pro, Intel i7-9750H (6 cores, 12 threads), Docker Desktop VM with 6 vCPU and 8 GB RAM, PostgreSQL 17.6 and Redis 7.4 in containers. Measured 2026-10-25 on commit `feat/m19-selfhosted`.

| Path | How | Result |
|---|---|---|
| Ingest gateway write path | `scripts/go.sh test -run x -bench BenchmarkWrite -benchtime 5s ./apps/ingest-gateway/`: authenticate, decode, relabel 500 series, enforce limits, re-encode, forward to a no-op store; one request at a time | **2.4 ms per 500-sample request ≈ 206,000 samples/s per core** (1.45 MB, 19.7k allocations per request) |
| Fleet heartbeats | `pnpm --filter @pcp/api load` (`apps/api/load/heartbeats.load.ts`): 200 enrolled agents, 10 heartbeats each, 50 concurrent, through the real API handlers and PostgreSQL in one process | **663 heartbeats/s**, p50 71 ms, p95 105 ms, p99 167 ms. Agents beat every 30 s, so one API process keeps up with about **19,000 agents** on this machine |
| Dashboard API reads | `node tests/load/run.ts` (k6 `tests/load/api.js`, 1 → 50 virtual users over 2 minutes, five authenticated reads per iteration, through Caddy) | see below |

## What these do not measure

- **TLS at the edge:** Caddy's mTLS termination for agent and ingest traffic.
- **Storage:** VictoriaMetrics ingest and query cost. VictoriaMetrics publishes its own single-node numbers; a 2 vCPU node ingests well over 100k samples/s.
- **Network:** latency between agents and the platform.

## Reading the numbers against the defaults

- **Default sampling:** an agent with host metrics and two packs sends roughly 300–600 series every 30 s, that is 10–20 samples/s. The per-agent limit is 20k series and 10k samples/s.
- **Gateway headroom:** at 206k samples/s per core, one gateway core covers about 10,000 such agents before the storage behind it becomes the limit.

## Re-running

```bash
scripts/go.sh test -run x -bench BenchmarkWrite -benchtime 5s ./apps/ingest-gateway/
LOAD_AGENTS=200 LOAD_ROUNDS=10 LOAD_CONCURRENCY=50 pnpm --filter @pcp/api load
node tests/load/run.ts        # starts and removes its own Compose stack; never against a shared host
```
