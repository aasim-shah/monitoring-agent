# WB-11 · Monitoring Packs and Service Monitoring

| | |
|---|---|
| **Milestones** | M10, M18.3 |
| **Spec** | §8.8, §8.9, §8.10, §11.6, §11.10, §11.11 |
| **Plan decisions** | D20, D24, D25; §3 collection, ingest limits |
| **Owners** | Platform (compiler, agent), Backend (packs API, proposals), Frontend (dashboards) |

## 1. Purpose and scope

How a customer goes from "agent installed" to "Redis, Kafka, Node.js, Nginx, and databases fully monitored" without changing their software: detection, pack proposals, credential delivery, configuration compilation, default alerts, dashboards, live boost, Level 2 guidance, and Level 1 managed exporters.

## 2. Actors

Admin/Operator (enables packs), customer server admin (creates monitoring users, applies Level 2 changes), agent, pack compiler, OpAMP server.

## 3. Use cases

| ID | Use case | Outcome |
|---|---|---|
| UC-11-01 | Detect services and propose packs | Per-host proposals ("Redis 7 detected — enable?") |
| UC-11-02 | Enable a Level 0 pack with dashboard-entered credentials | Credential sealed to agent; config pushed; metrics flow |
| UC-11-03 | Enable a pack using a local secret file | Agent reads `/etc/pcp-agent/secrets/<pack>.yaml` |
| UC-11-04 | Follow Level 2 guided setup and verify | Customer applies change; platform confirms metrics arrive |
| UC-11-05 | Install a Level 1 managed exporter (M18) | Signed exporter installed via `pcp-helper`, bound to 127.0.0.1 |
| UC-11-06 | Disable or remove a pack | Config removed; alerts disabled; history kept |
| UC-11-07 | Live boost on a service page | 5 s collection for 10 min; auto revert |
| UC-11-08 | View service dashboards | Redis, Kafka, Node.js, Nginx, database panels |
| UC-11-09 | Default alerts created on enable | Pack alert rules compiled to vmalert (WB-13) |
| UC-11-10 | Scrape a customer's existing exporters | `prometheus` receiver on localhost; no duplicate collection |
| UC-11-11 | Reach a cardinality limit | New series rejected; usage warning; owner notified |
| UC-11-12 | Upgrade a pack version | New version compiled and rolled out; rollback on failure |

## 4. Flows

### UC-11-01 → UC-11-02: Detect, propose, enable

```mermaid
sequenceDiagram
  participant AG as Agent (discovery)
  participant API as Control API
  participant UI as Dashboard
  participant B as Browser crypto
  participant OP as OpAMP server
  AG->>API: Observations (process redis-server, port 6379)
  API->>API: Match pack detect rules → pack_proposals
  UI->>API: List proposals
  UI-->>UI: "cache-vps-01: Redis 7 detected — enable pack?"
  UI->>B: Admin enters Redis monitor user/password
  B->>B: crypto_box_seal(credential, agent X25519 public key)
  B->>API: POST /api/v1/agents/:id/packs {packId, settings, sealedCredential}
  API->>API: compileAgentConfig → yaml + hash; audit "pack.enabled"
  API->>OP: agent-config-changed
  OP->>AG: New config + sealed credential
  AG->>AG: Decrypt, store in /etc/pcp-agent/secrets (0600), restart collector
  AG->>API: Ack → API deletes ciphertext
  AG->>AG: Redis receiver collects every 30 s → ingest
```

### Pack catalog

| Pack | Detect | Collector | Level | Credentials | Key metrics | Default alerts |
|---|---|---|---|---|---|---|
| host | Always | `hostmetrics` | 0 | None | CPU, memory, load, disk, filesystem, network | Disk full forecast < 24 h; memory > 90% 10 min; systemd unit failed |
| docker | `dockerd` | `docker_stats` via read-only socket proxy | 0 opt-in | None | Container CPU, memory, restarts, health | Restart loop; unhealthy |
| redis | `redis-server`, 6379 | `redis` receiver (+ optional `redis_exporter`) | 0 (exporter 1) | Read-only ACL user | Memory vs maxmemory, ops/s, hit ratio, evictions, clients, replication | Evictions > 0; memory > 85%; replication link down |
| kafka | `kafka.Kafka`, 9092 | `kafkametrics` | 0 | SASL Describe | Brokers, partitions, consumer lag, topic throughput | Offline partitions > 0; under-replicated; lag rising 15 min |
| kafka-jvm | Kafka present | JMX exporter Java agent, scraped by `prometheus` | 2 | None | Request latency, ISR, heap, GC | Request latency; ISR shrink |
| nodejs | `node`, PM2, systemd | Process metrics + health probe (+ OTel/`/metrics`) | 0 (deep 2) | None | CPU, memory, restarts, health (+ RED, event loop lag) | Restart loop; health failing; event loop lag > 200 ms; 5xx above baseline |
| nginx | `nginx` | `nginx` receiver (`stub_status`) + access log | 2 | None | Requests/s, 5xx, upstream latency | 5xx rate; upstream latency |
| postgresql / mongodb / mysql | Process + port | Matching receiver | 0 | Read-only DB user | Connections, replication lag, storage | Connection saturation; replication lag; storage growth |
| http-check | Manual | `httpcheck` | 0 | None | Status, latency | Endpoint down; latency over threshold |

### UC-11-04: Level 2 guided setup (Node.js example)

1. Dashboard shows the guide with exact commands (spec §8.9).
2. Customer installs packages, sets `NODE_OPTIONS` and `OTEL_*`, restarts the app.
3. A verification job checks for `http.server.request.duration` series with `service.name=firemaps-api`.
4. Found → "Deep metrics active"; not found after 15 min → troubleshooting checklist.

Kafka JVM: add `-javaagent:jmx_prometheus_javaagent.jar=127.0.0.1:7071:/etc/kafka/jmx.yaml` to broker options, restart broker, platform scrapes `127.0.0.1:7071`.
Nginx: enable `stub_status` on `127.0.0.1`, reload.

### UC-11-05: Level 1 managed exporter

1. Requires `pcp-helper` installed with `--enable-pack-installer`.
2. Proposal goes through the action approval flow (WB-16).
3. Signed Ed25519 task → helper verifies signature, expiry, local allowlist.
4. Helper downloads signed exporter, verifies, installs systemd unit bound to `127.0.0.1`.
5. `pack remove` reverses it.

### UC-11-07: Live boost

1. User opens a service page → `POST /api/v1/agents/:id/live-boost {packId}`.
2. Task TTL 10 min sets that pack's interval to 5 s.
3. Browser opens `GET /api/v1/assets/:id/live` (SSE); API queries every 5 s.
4. Agent reverts at TTL even if disconnected. Max 3 concurrent boosts per tenant.

## 5. Business rules

| ID | Rule |
|---|---|
| BR-11-01 | Nothing is collected until a user enables the pack. |
| BR-11-02 | Credentials come only from the admin (local file or sealed entry); the agent never reads app config. |
| BR-11-03 | The control plane never sees plaintext pack credentials and deletes ciphertext after ack. |
| BR-11-04 | Level 2 changes are never performed by the platform. |
| BR-11-05 | Level 1 installs require `pcp-helper`, approval, signed tasks, and a local allowlist. |
| BR-11-06 | Every compiled config contains `memory_limiter`, metric allowlist filter, drop-label transform, `batch`. |
| BR-11-07 | Exporters bind to `127.0.0.1` only. |
| BR-11-08 | Live boost: 5 s for 10 min; max 3 per tenant; agent-side TTL revert. |
| BR-11-09 | Metric names follow OpenTelemetry semantic conventions. |

## 6. Data

`monitoring_packs`, `pack_versions`, `pack_proposals`, `agent_pack_assignments`, `agent_public_keys`, `telemetry_limits`, `telemetry_usage`, `alert_rules` (pack defaults).

## 7. API

```http
GET    /api/v1/monitoring-packs
GET    /api/v1/agents/:id/pack-proposals
POST   /api/v1/agents/:id/packs
DELETE /api/v1/agents/:id/packs/:packId
POST   /api/v1/agents/:id/live-boost
GET    /api/v1/assets/:id/live          (SSE)
```

## 8. Screens

Host detail → Detected services and proposals, Enable pack dialog (credentials with "create user" commands, or "use local secret file"), Guided setup page, Service dashboards (Redis, Kafka, Node.js, Nginx, DB), Settings → Usage and limits.

## 9. Edge cases

| Case | Expected behavior |
|---|---|
| Redis requires TLS | Pack settings support TLS with CA path on host |
| Kafka with multiple brokers on different hosts | Enable the kafka pack on one host for cluster metrics; broker JVM pack per broker |
| Wrong credentials | Receiver errors reported via OpAMP health → pack status "authentication failed" |
| Service moves to another port | Detection updates proposal; pack settings flagged "endpoint not responding" |
| Pack upgrade breaks config | Supervisor restores last good config; pack version rolled back |
| Many Node.js apps on one host | One pack instance per app (PM2 app name / systemd unit) |

## 10. Test cases

| ID | Covers | Given / When / Then |
|---|---|---|
| TC-11-01 | UC-11-01 | `redis-server` on 6379 observation → proposal created |
| TC-11-02 | BR-11-03 | Seeded credential absent from DB dump, logs, Redis after enable; ciphertext deleted after ack |
| TC-11-03 | BR-11-06 | Every golden config contains required processors; `pcp-otelcol validate` passes |
| TC-11-04 | Pack e2e | Each pack's key metrics appear within 90 s against a real service container |
| TC-11-05 | BR-11-08 | Agent reverts boost at TTL with fake clock while disconnected; 4th boost rejected |
| TC-11-06 | UC-11-04 | Verification turns green when fixture OTel metrics arrive |
| TC-11-07 | UC-11-10 | Existing `redis_exporter` on 9121 scraped; no duplicate Redis series from receiver |
| TC-11-08 | UC-11-11 | Over limit → warning shown; owner notified once per hour |
| TC-11-09 | BR-11-05 | Unsigned / non-allowlisted Level 1 task refused by helper |

## 11. Task checklist

- [ ] M10.1 Pack schema and loader — M6b ships a code catalog (`apps/api/src/modules/packs/catalog.ts`); versioned pack files in M10
- [x] M10.2 Pack compiler — M6b scope: `collector.Config` per pack + `filter/allowlist`, validated by `pcp-otelcol validate` ([M6b-agent-packs](../handoffs/M6b-agent-packs.md)); drop-label transform (BR-11-06) in M10 ([M10-execution-log](../handoffs/M10-execution-log.md))
- [x] M10.3 Pack catalog — redis, postgresql, mysql, mongodb, kafka, nginx, nodejs ([M6b-packs-api](../handoffs/M6b-packs-api.md))
- [x] M10.4 Detection, proposals, credential delivery — /proc discovery, suggested packs, browser-sealed credentials deleted after ack ([M6b-discovery](../handoffs/M6b-discovery.md))
- [x] M10.5 Level 2 guidance — Node.js OTLP, Kafka JMX exporter, nginx stub_status, with live verification ([M10-execution-log](../handoffs/M10-execution-log.md))
- [x] M10.6 Usage and limits UI — gateway usage every 60 s, usage page, limit banner, hourly owner notice ([M10-execution-log](../handoffs/M10-execution-log.md))
- [x] M10.7 Live boost — 5 s for 10 minutes, reverted by the agent, at most 3 per organization ([M10-execution-log](../handoffs/M10-execution-log.md))
- [x] M10.8 Service dashboards — fixed-PromQL charts per pack on the host page ([M6b-services-ui](../handoffs/M6b-services-ui.md)); Redis and PostgreSQL verified end to end
- [x] M18.3 Level 1 managed exporters ([M18](../handoffs/M18-execution-log.md))

## 12. Acceptance criteria

1. Scenario E steps 1–8 pass in staging (WB-18 J2).
2. Customer software is not restarted or modified for any Level 0 pack.

## 13. Open items

- Additional packs after pilot (RabbitMQ, Elasticsearch, Memcached, PHP-FPM) based on pilot demand.
