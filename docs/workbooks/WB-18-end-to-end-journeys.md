# WB-18 · End-to-End Journeys

| | |
|---|---|
| **Milestones** | Exit gates of M9, M10, M12, M16, M19 |
| **Spec** | §20 Scenarios A–E, §24.2, §27 |
| **Owners** | Tech lead (journey owners), QA |

## 1. Purpose

Each journey strings use cases from the other workbooks into one real customer story. Journeys are the basis of end-to-end Playwright suites and of pilot acceptance. Each step names the use case that implements it.

## 2. Journeys

| ID | Journey | Spec | Primary workbooks |
|---|---|---|---|
| J1 | Onboard an already-running product | Scenario A, §27 | WB-01 → WB-11 |
| J2 | VPS fleet with no existing monitoring | Scenario E | WB-03, WB-05, WB-11, WB-12 |
| J3 | API latency incident | Scenario B | WB-11, WB-13, WB-14, WB-16 |
| J4 | Add a second product | Scenario C | WB-01, WB-02, WB-10 |
| J5 | Enterprise self-hosted deployment | Scenario D | WB-17 |
| J6 | A normal operations day | — | WB-09, WB-13, WB-15 |
| J7 | Offboarding | — | WB-03, WB-05, WB-17 |

## 3. J1 · Onboard an already-running product (FireMaps)

Baseline needs no code change to the running product, no restart, and no inbound port.

| Step | Who | What happens | Use case |
|---|---|---|---|
| 1 | Owner | Signs up with Google (login scopes only) | UC-01-02 |
| 2 | Owner | Creates "Example Company"; enrolls MFA | UC-01-07, UC-01-05 |
| 3 | Owner | Creates FireMaps with Production and Staging; adds domains and repos as hints | UC-01-08, UC-01-09 |
| 4 | Admin | Connects Cloudflare with a scoped token; selects zones | UC-06-01, UC-02-05 |
| 5 | Admin | Installs GitHub App on selected repos | UC-06-04 |
| 6 | Admin | Connects Google with the full read scope set; assigns GA4, Firebase, Play, Search Console | UC-08-01, UC-08-03 |
| 7 | Admin | Creates a fleet enrollment token | UC-03-01 |
| 8 | Server admin | Runs the installer (or Ansible) on each VPS | UC-05-01, UC-05-02 |
| 9 | System | Agents enroll; host metrics appear within 60 s | UC-03-02, UC-04-01 |
| 10 | System | Discovery proposes packs per host | UC-11-01 |
| 11 | Admin | Creates read-only Redis/Kafka users; enables packs with sealed credentials | UC-11-02 |
| 12 | Server admin | Installs private connector worker; creates read-only MongoDB user | UC-07-01, UC-07-02 |
| 13 | Admin | Registers website monitors after domain verification | UC-09-01, UC-09-02 |
| 14 | System | Correlation proposes DNS → host → service → database edges | UC-10-03 |
| 15 | Admin | Reviews and confirms ambiguous edges | UC-10-04 |
| 16 | Admin | Checks coverage report | UC-10-11 |
| 17 | Admin | Adds Slack and email channels; reviews default alerts | UC-13-09, UC-11-09 |
| 18 | Admin | Schedules daily report at 08:00 | UC-15-01 |
| 19 | Any member | Asks the AI a first question | UC-14-01 |

Optional deeper integration afterwards: Node.js OTel instrumentation, Kafka JMX, Nginx `stub_status` (UC-11-04).

## 4. J2 · VPS fleet with no existing monitoring (Scenario E)

| Step | What happens | Use case |
|---|---|---|
| 1 | Customer runs Kafka on 3 VPS, Redis on 1, Node.js apps on 2; no Prometheus | — |
| 2 | Admin creates a fleet token (`max_uses=6`) | UC-03-01 |
| 3 | Installer runs on all 6 hosts with `--packs host` | UC-05-01 |
| 4 | Agents enroll; host metrics immediately | UC-03-02, UC-04-01 |
| 5 | Discovery detects Kafka, Redis, Node.js (PM2); proposals shown | UC-11-01 |
| 6 | Admin creates monitoring users, enters them sealed, enables packs | UC-11-02 |
| 7 | OpAMP delivers config; metrics flow; default alerts created | UC-04-07, UC-11-09 |
| 8 | Connection evidence proposes Node.js → Kafka and Node.js → Redis; Admin confirms | UC-10-03, UC-10-04 |
| 9 | Dashboards show consumer lag, Redis memory/evictions, Node.js restarts; live tail available | UC-11-08, UC-12-01 |
| 10 | Admin applies Level 2 guide for one Node.js API; RED metrics appear | UC-11-04 |

## 5. J3 · API latency incident (Scenario B)

| Step | What happens | Use case |
|---|---|---|
| 1 | p95 latency on firemaps-api exceeds threshold for 10 min | UC-13-02 |
| 2 | vmalert notifies; incident created and deduplicated | UC-13-04 |
| 3 | Graph adds dependents (website, mobile apps) as potential impact | UC-10-10 |
| 4 | Incident attaches deploy `a1b2c3` from 12 min earlier, MongoDB connection saturation | UC-13-04 |
| 5 | Slack notification with links | UC-13-05 |
| 6 | Operator acknowledges; opens service page (live boost) and log tail | UC-13-06, UC-11-07, UC-12-01 |
| 7 | Operator clicks "Ask AI"; AI correlates timeline with evidence and states uncertainty | UC-14-02 |
| 8 | AI proposes restarting `firemaps-api.service` | UC-16-03 |
| 9 | Approver reviews dry-run impact and approves | UC-16-04, UC-16-05 |
| 10 | `pcp-helper` restarts the allowlisted unit; verification checks it is active | UC-16-08, UC-16-09 |
| 11 | Latency recovers; alert resolves; incident resolved; postmortem metadata added | UC-13-08, UC-13-11 |

## 6. J4 · Add a second product (Scenario C)

| Step | What happens | Use case |
|---|---|---|
| 1 | Admin creates Product B in the same organization | UC-01-08 |
| 2 | Reuses the existing Cloudflare connection; selects only Product B zones | UC-02-05 |
| 3 | New enrollment for Product B hosts; a shared VPS is linked to both products | UC-03-01, UC-10-12 |
| 4 | Analyst invited with scope Product B only | UC-01-10, UC-01-12 |
| 5 | Analyst sees shared host and B services; never FireMaps services or edges | Review Focus #5 |
| 6 | Product B reports and notifications are independent | UC-15-01, UC-13-09 |

## 7. J5 · Enterprise self-hosted (Scenario D)

| Step | What happens | Use case |
|---|---|---|
| 1 | Enterprise installs the Compose stack on internal infrastructure | UC-17-02 |
| 2 | Bootstraps over private HTTP, then configures internal DNS/TLS | UC-17-03 |
| 3 | Configures OIDC, encryption root key, backups | UC-17-02, UC-17-05 |
| 4 | Installs agents and private workers internally | UC-05-02, UC-07-01 |
| 5 | Allows approved external providers through outbound firewall rules | UC-06-01, UC-08-01 |
| 6 | Points AI at a customer-controlled LLM endpoint, or disables AI | UC-17-13, UC-14-06 |
| 7 | Operational records stay in customer infrastructure | BR-17-08 |

## 8. J6 · A normal operations day

| Time | What happens | Use case |
|---|---|---|
| 08:00 local | Daily report delivered with coverage section | UC-15-02, UC-15-03 |
| Morning | GA4 sync marks today partial; Search Console updates | UC-08-04, UC-08-08 |
| Midday | TLS certificate for `api.firemaps.com` expires in 13 days → warning | UC-09-03 |
| Afternoon | Kafka consumer lag rises after a deploy → incident, correlated with deploy | UC-13-02, UC-13-04 |
| Evening | Google token revoked by a departing employee → reauthorization banner | UC-08-10 |
| Night | Agent on staging offline for 2 h; reconnects; backlog drains without double counting | UC-03-06, UC-04-04 |

## 9. J7 · Offboarding

| Step | What happens | Use case |
|---|---|---|
| 1 | Admin revokes all agents | UC-03-05 |
| 2 | Server admins run `--uninstall` | UC-05-07 |
| 3 | Admin deletes connections (crypto-shred secrets); revokes OAuth grants, GitHub App, Cloudflare token at providers | UC-02-09 |
| 4 | Owner exports data, then requests organization deletion | UC-17-09 |
| 5 | After the 30-day grace period, data is purged | UC-17-09 |
| 6 | The customer's running product is unaffected: nothing in it depended on the platform | — |

## 10. Journey test mapping

| Journey | Suite | Environment |
|---|---|---|
| J1 | `tests/e2e/journeys/onboarding.spec.ts` (mock providers) + staging manual run (real providers) | CI + staging |
| J2 | `tests/agent-e2e/journeys/fleet.test.ts` | CI (systemd containers) |
| J3 | `tests/e2e/journeys/incident.spec.ts` | CI |
| J4 | `tests/e2e/journeys/second-product.spec.ts` | CI |
| J5 | `tests/smoke/self-hosted.test.ts` | CI + clean VPS |
| J6 | Staging soak (7 days) before pilot | Staging |
| J7 | `tests/e2e/journeys/offboarding.spec.ts` | CI |

## 11. Pilot acceptance link

Pilot acceptance (spec §24.2 items 1–12) is satisfied when J1, J2, J3, and J5 pass with real customers or on clean infrastructure.
