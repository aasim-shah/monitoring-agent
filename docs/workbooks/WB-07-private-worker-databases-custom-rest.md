# WB-07 · Private Connector Worker, Databases and Custom REST

| | |
|---|---|
| **Milestones** | M8 |
| **Spec** | §4.6, §7.3, §7.6, §18.1 (SSRF) |
| **Plan decisions** | §3 private worker, custom REST |
| **Owners** | Backend |

## 1. Purpose and scope

Reaching data that must stay inside the customer network: private databases (PostgreSQL, MongoDB, MySQL), internal HTTP APIs, and internal Prometheus/Grafana. Also the custom REST connector for any API, with SSRF protection.

## 2. Actors

Admin (configures), customer server admin (installs worker, creates read-only users, stores secrets locally), private connector worker, worker jobs.

## 3. Use cases

| ID | Use case | Outcome |
|---|---|---|
| UC-07-01 | Install the private connector worker | Worker enrolled as `private_worker` (same identity model as agents) |
| UC-07-02 | Configure a database connection with a local `secretRef` | Control plane stores only non-secret config + opaque reference |
| UC-07-03 | Validate database connection and read-only privileges | `connected`, or `permission_denied` if the user can write |
| UC-07-04 | Collect database health and storage statistics | Connections, replication lag, storage, slow-query summary |
| UC-07-05 | Run an approved aggregate template | Business metric (e.g. daily signups count) stored as KPI |
| UC-07-06 | Admin acknowledges a write-capable user override | Connection allowed; audited; warning badge stays |
| UC-07-07 | Configure a custom REST integration | Endpoints, auth reference, pagination, mappings, schedule saved |
| UC-07-08 | Block an SSRF attempt | Request refused with reason |
| UC-07-09 | Call a private internal API through the worker | Allowlisted private target reached from inside the network |

## 4. Flows

### UC-07-01: Install worker

1. Admin creates an enrollment with type `private_worker`.
2. Server admin runs the worker (Docker image or systemd package) with the token.
3. Worker enrolls (WB-03 flow), long-polls `/agent/v1/tasks`.

### UC-07-02 → UC-07-04: Private database (spec §7.3)

```mermaid
sequenceDiagram
  participant UI as Dashboard
  participant API as Control API
  participant W as Private worker
  participant DB as Customer database
  UI->>API: Save DB connection (host, port, db, TLS, secretRef)
  API->>API: Create signed connector_op task (validate)
  W->>API: Long-poll tasks
  API-->>W: Signed task
  W->>W: Verify signature/expiry; load /etc/pcp-worker/secrets/<secretRef>.yaml
  W->>DB: Connect over TLS with read-only user
  W->>DB: Check privileges (no INSERT/UPDATE/DELETE/DDL)
  DB-->>W: Metadata, privileges
  W->>API: Bounded sanitized result (≤256 KB)
  API-->>UI: Connected / permission_denied / errors
```

Health checks every 5 min:

| Database | Health data |
|---|---|
| PostgreSQL | Connections vs `max_connections`, replication lag, database sizes, `pg_stat_statements` top 10 by total time if available |
| MongoDB | `serverStatus` connections, replication set state and lag, `dbStats` sizes |
| MySQL | `Threads_connected` vs `max_connections`, replica lag, schema sizes, slow query count |

### UC-07-05: Aggregate templates

- Templates are named and reviewed (e.g. `signups_per_day`), stored with the connector, parameterized only by time window.
- Admin selects templates; no free-form query editor exists.
- Limits: 5 s timeout, 1,000 rows; result stored as KPI with definition, unit, timezone, window, source (WB-09).

### UC-07-07 → UC-07-09: Custom REST

Configuration: base URL, auth reference (API key/OAuth/mTLS), allowlisted endpoints, method, query params, pagination, timeout, retry, JSONPath extraction mapping, schedule, sensitivity classification.

Request path:

1. `assertPublicDestination(url)` resolves DNS and rejects loopback, private, link-local, metadata, and unspecified addresses (unless execution is `private` and the target is allowlisted).
2. The client connects to the resolved address (no second lookup → no DNS rebinding).
3. Each redirect (max 3) is re-validated.
4. Response capped at 1 MB; timeout 10 s.
5. JSONPath mappings extract resources and metrics.

## 5. Business rules

| ID | Rule |
|---|---|
| BR-07-01 | Database credentials stay in the customer network; the control plane stores only an opaque `secretRef`. |
| BR-07-02 | No free-form SQL or queries; only named aggregate templates. |
| BR-07-03 | Database users must be read-only; write-capable users need an audited override. |
| BR-07-04 | Worker results ≤ 256 KB; database query timeout 5 s; ≤ 1,000 rows. |
| BR-07-05 | Worker executes only signed, unexpired tasks. |
| BR-07-06 | SSRF guard blocks `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `0.0.0.0/8`, `::1`, `fc00::/7`, `fe80::/10` for central execution. |
| BR-07-07 | `secretRef` must be a simple name (no `/`, no `..`). |

## 6. Data

`connections` (execution_location `private`, config with `secretRef`), `connection_health`, `metric_definitions`, `metric_aggregates`, `agent_tasks`.

## 7. Screens

Integrations → Databases (PostgreSQL/MongoDB/MySQL wizard with "create read-only user" instructions per database), Custom REST wizard (endpoints, mapping preview against a sample response), Worker fleet (in Agents).

## 8. Edge cases

| Case | Expected behavior |
|---|---|
| Database unreachable | Distinguish network, TLS, authentication, and database health failures; avoid repeated expensive retries |
| TLS not available on database | Connection refused by default; explicit, audited "allow non-TLS on private network" option |
| `pg_stat_statements` missing | Health continues; slow-query panel shows "extension not installed" |
| Worker offline | Database connection shows `degraded` + "worker offline"; no zeros |
| Custom API returns HTML instead of JSON | Mapping fails; batch quarantined with sanitized diagnostic |
| Custom API paginates forever | Max pages per run (100) then stop with warning |

## 9. Test cases

| ID | Covers | Given / When / Then |
|---|---|---|
| TC-07-01 | BR-07-05 | Unsigned or expired task → worker refuses |
| TC-07-02 | BR-07-07 | `secretRef="../x"` → refused |
| TC-07-03 | BR-07-03 | PostgreSQL user with INSERT → `permission_denied` |
| TC-07-04 | BR-07-02 | Registering a write template is impossible (type and runtime check) |
| TC-07-05 | BR-07-04 | Template returning 5,000 rows → 1,000 with `truncated: true` |
| TC-07-06 | UC-07-04 | Testcontainers PostgreSQL/MongoDB/MySQL health fields populated |
| TC-07-07 | BR-07-06 | Each blocked range is refused for central execution |
| TC-07-08 | UC-07-08 | DNS rebinding (public then private) is blocked |
| TC-07-09 | UC-07-08 | Redirect to `169.254.169.254` is blocked |
| TC-07-10 | UC-07-09 | Private execution reaches an allowlisted `10.x` target, refuses a non-allowlisted one |

## 10. Task checklist

- [x] M8.1 Private connector worker ([M8-private-worker](../handoffs/M8-private-worker.md), [M8-private-connections](../handoffs/M8-private-connections.md))
- [x] M8.2 Database connectors ([M8-database-connectors](../handoffs/M8-database-connectors.md), UI [M8-databases-ui](../handoffs/M8-databases-ui.md))
- [x] M8.3 Custom REST connector and SSRF guard ([M8-ssrf](../handoffs/M8-ssrf.md), [M8-custom-rest](../handoffs/M8-custom-rest.md)); dashboard UI with M7 Integrations

## 11. Acceptance criteria

1. MongoDB health for a FireMaps-like fixture arrives through the private worker.
2. All SSRF tests pass.
3. No database credential is present in the control plane database.

## 12. Open items

- Initial aggregate template library (signups, orders, active users) to define with pilot customers.
