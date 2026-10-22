# Handoff — M9.2 Discovery sources and correlation rules

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-23 |
| **Branch** | `feat/m9-discovery-graph` |
| **Plan** | M9 plan Task 3 |
| **Workbooks** | WB-10 UC-10-01/03/07, BR-10-03/04 |

## Delivered

- **Agent egress IP.** `AgentAuthGuard` already requires the trusted proxy (Caddy) as the TCP peer. Caddy replaces any client-sent `X-Forwarded-For` and appends the real client address, so the guard takes the last entry as the agent's IP (`AgentIdentity.clientIp`). The heartbeat stores it in `agents.last_seen_ip`.
- **`DiscoveryService.run(ctx, productId)`** (`apps/api/src/modules/discovery`):
  - A per-product advisory lock prevents a background run and an on-demand run from racing. The lock was added after the test caught that race.
  - Each run records one discovery run for each source (`agent`, `connector`, `product_config`), and `completeRun` drives the lifecycle (missing after 3 runs).
- **Assets created by a run:**

| Source | Asset | Identity |
|---|---|---|
| Active agents | `host` (or `worker` for private workers) | `agent:<id>` |
| Agent inventory | `service` | `agent:<id>/<pack>` |
| Private DB connections scoped to the product | `database` | `connection:<id>` |
| `product.domains` | `website` | `domain:<host>` |

  Host attributes are OS, arch, version, egress IP, and environment.
- **Rules:**

| Rule | Edge | Confidence / state |
|---|---|---|
| host-to-service | host `HOSTS` service | 0.95 direct → **verified** |
| dns-to-host | website `ROUTES_TO` host (A/AAAA = agent egress IP) | 0.8 → proposed. A verified route whose host IP is no longer in DNS is **drifted**. |
| db-on-host | database `DEPLOYED_ON` host (connection host = host IP or hostname, not loopback) | 0.8 → proposed |
| name-similarity | database `DEPLOYED_ON` the only host with a same-engine service | 0.3 → proposed, never auto-verified |

- **Triggers:**
  - `POST /api/v1/products/:productId/discovery/run` (`product.manage`; viewers get 404)
  - every `POST /agent/v1/inventory`, debounced to one run per product per minute (Redis `SET NX EX 60`)
- **DNS.** The resolver is injectable (`DNS_RESOLVER`; the system default combines `resolve4` and `resolve6`). The test app accepts a fake one.

## Notes

- There is no product update route yet, so domains are set when the product is created. A domain editor would help, either alongside M13 websites or as a small follow-up.
- A newly validated private connection appears at the next run: on demand, or at the next agent inventory.

## Tests

- `discovery.int.test.ts`, 5 tests:
  - the egress IP is recorded
  - fixture graph: HOSTS verified ×2 and ROUTES_TO proposed; a second run adds nothing
  - a private database linked to its host by IP
  - DNS moves to a new host: the old route drifts and a new one is proposed
  - the inventory triggers a background run; a viewer gets 404
- Affected suites: agents, packs, connections, and discovery, 86 passed.
