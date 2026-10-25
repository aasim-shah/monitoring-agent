# Handoff Board

Status of every master-plan task. Each started task has a handoff document in this folder (`<task-id>-<slug>.md`) describing what was delivered, how to verify it, test results, decisions, limitations, and next steps.

Status values: **Done** (complete, tests green), **In progress** (work started, handoff describes current state), **Awaiting approval** (delivered, needs a human decision), **Not started**.

Branches: `feat/m0-m1-foundation` (M0, M1) → `feat/m2-identity-tenancy` (M2, stacked). Execution plans: `docs/superpowers/plans/2026-10-22-m0-m1-foundation.md`, `2026-10-22-m2-identity-tenancy.md`. Logs: [M0-M1](M0-M1-execution-log.md), [M2](M2-execution-log.md), [M3](M3-execution-log.md). Platform runbook for M2 deployment: [M2-compose-migrate](M2-compose-migrate.md).

## Milestone summary

| Milestone | Status | Notes |
|---|---|---|
| M0 Contracts and decisions | Delivered, awaiting approval | ADRs (M0.1) and threat model (M0.3) need tech lead + security owner acceptance; M0.2, M0.4 done |
| M1 Monorepo, CI, Compose | Done | Exit gate met locally (clean clone → `docker compose up` healthy); first GitHub CI run pending a remote |
| M2 Identity, tenancy, RLS, RBAC, audit | Done | Branch `feat/m2-identity-tenancy`; also delivered M4.1 envelope encryption |
| M3 Dashboard shell | Done | Branch `feat/m3-dashboard-shell`; Playwright journeys pass against the Compose stack |
| M4 Connectors and jobs | Done | Branch `feat/m4-connectors`; data model, SDK, runtime, jobs, connections API, [Compose](M4-compose.md); [execution log](M4-execution-log.md) |
| M5 Agent enrollment and identity | Done | Branch `feat/m5-onboarding-agents`; exit gate passes through Caddy mTLS and from the dashboard; [execution log](M5-execution-log.md) |
| M6a Host metrics path | Done | Branch `feat/m6-host-agent`; install.sh → metrics in Infrastructure; [execution log](M6a-execution-log.md) |
| M6b Service discovery and monitoring packs | Done | Branch `feat/m6b-services`; discovery, packs API, agent applies packs, services UI; [execution log](M6b-execution-log.md). OpAMP, OTLP logs, OS matrix moved to M10/M11 |
| M8 Private worker, databases, custom REST | Done | Branch `feat/m8-private-worker`; deployed; [execution log](M8-execution-log.md) |
| M8b Managed databases (Atlas, Supabase) | Done | Deployed; [M8b-managed-databases](M8b-managed-databases.md) |
| M9 Discovery, graph, topology | Done | Branch `feat/m9-discovery-graph`; deployed; [execution log](M9-execution-log.md) |
| M11 Logs (live tail, log-derived metrics) | Done | Branch `feat/m11-logs`; deployed; [execution log](M11-execution-log.md) |
| M12 Alerts, incidents, notifications | Done | Branch `feat/m12-alerts`; deployed; [execution log](M12-execution-log.md) |
| M13a Website monitoring | Done | Branch `feat/m13a-websites`; deployed; [execution log](M13a-execution-log.md) |
| M13b Google sources and KPIs | Done | Branch `feat/m13b-google`; deployed; GA4, Search Console, Firebase, Play vitals; [execution log](M13b-execution-log.md), [setup](M13b-google.md) |
| M16 Operational actions and approvals | Done | Branch `feat/m16-actions`; deployed; agent 0.3.0 with opt-in pcp-helper; [execution log](M16-execution-log.md) |
| M15 Reports and schedules | Done | Branch `feat/m15-reports`; deployed; [execution log](M15-execution-log.md) |
| M14 AI assistant | Done | Branch `feat/m14-ai`; deployed; [execution log](M14-execution-log.md) |
| M7 SaaS integrations and webhooks | Done | Branch `feat/m7-integrations`; deployed; Cloudflare, GitHub, Prometheus, Grafana; [execution log](M7-execution-log.md) |
| M19 Hardening (production-critical subset) | Done | Branch `feat/m19-hardening`; deployed; backups + restore drill, watchdog, CSP, zod fix, tenant export/deletion, lost-task fix; [execution log](M19-execution-log.md) |
| M10 Monitoring packs (remainder) | Done | Branch `feat/m10-packs`; deployed; usage and limits, live boost (agent 0.4.0), Level 2 guides for Node.js, Kafka, nginx, edge drop-label transform; [execution log](M10-execution-log.md) |
| M15b Daily report: 24 h activity and trends | Done | Branch `feat/m15b-report-trends`; deployed with M10; database rows added, website speed, Google KPI trends; [execution log](M15b-execution-log.md) |
| M17 Installation methods | Done | Branch `feat/m17-install`; deployed; Ansible, cloud-init, Compose profile, assisted SSH install; [execution log](M17-execution-log.md) |
| M18; M19.2/.4/.7 | Not started | M13.4 Google Ads gated on a developer token; pentest, load baselines, self-hosted packaging, and pilot need people or a separate host |

## Maintenance

| Change | Status | Handoff |
|---|---|---|
| CI dependency and secret scan fixes (first GitHub run) | Done | [CI-dependency-security](CI-dependency-security.md) |

## Tasks

| Task | Title | Status | Handoff |
|---|---|---|---|
| M0.1 | Repository bootstrap and ADRs | Awaiting approval | [M0.1](M0.1-adrs.md) |
| M0.2 | Shared contracts packages | Done | [M0.2](M0.2-shared-contracts.md) |
| M0.3 | Threat model and data classification | Awaiting approval | [M0.3](M0.3-threat-model.md) |
| M0.4 | OpenAPI v1 draft | Done | [M0.4](M0.4-openapi.md) |
| M1.1 | Monorepo tooling | Done | [M1.1](M1.1-monorepo-tooling.md) |
| M1.2 | Application skeletons | Done | [M1.2](M1.2-app-skeletons.md) |
| M1.3 | Compose and Caddy | Done | [M1.3](M1.3-compose-caddy.md) |
| M1.4 | CI pipeline | Done | [M1.4](M1.4-ci.md) |
| M2.1 | Database package, roles, RLS | Done | [M2.1](M2.1-database-rls.md) |
| M2.2 | Tenant context and `withTenant` | Done | [M2.2](M2.2-tenant-security.md) |
| M2.3 | Authentication | Done | [part 1](M2.3-identity-primitives.md), [part 2](M2.3-authentication-api.md) |
| M2.4 | Organizations, products, environments, RBAC guard | Done | [M2.4](M2.4-organizations-rbac.md) |
| M2.5 | Audit log | Done | [M2.5](M2.5-audit-log.md) |
| M2.6 | Members and invitations | Done | [M2.6](M2.6-members-invitations.md) |
| M3.1 | Web foundation | Done | [part 1](M3.1-web-foundation.md), [part 2](M3.1-auth-pages.md), [part 3](M3.1-app-shell.md) |
| M3.2 | Organization, product, environment, member, audit screens | Done | [M3.2](M3.2-screens.md) |
| M3.3 | Typed API client | Done | [M3.3](M3.3-api-client.md) |
| M4.1 | Envelope encryption | Done | [envelope](M2.3-identity-primitives.md), [storage](M4.2-connector-runtime.md) |
| M4.2 | Connector SDK runtime | Done | [SDK](M4.2-connector-sdk.md), [runtime](M4.2-connector-runtime.md) |
| M4.3 | Connection lifecycle and registry | Done | [M4.3](M4.3-connections-api.md) |
| M4.4 | Job framework | Done | [M4.4](M4.4-jobs.md) |
| M5.1 | Agent CA and certificate issuance | Done | [M5.1](M5.1-agent-ca.md) |
| M5.2 | Enrollment | Done | [M5.2](M5.2-enrollment.md) |
| M5.3 | mTLS edge and agent authentication | Done | [M5.3](M5.3-agent-auth.md) |
| M5.4 | Heartbeats and fleet status | Done | [M5.4](M5.4-heartbeats.md) |
| M5.5 | Tasks and streams | Done | [M5.5](M5.5-tasks.md) |
| M5.6 | Rotation and revocation | Done | [M5.6](M5.6-rotation-revocation.md) |
| M5.7 | Fleet UI | Done | [M5.7](M5.7-fleet-ui.md) |
| M6.1 | Agent distribution build | Done (M6a scope) | [M6.1](M6.1-collector-dist.md) |
| M6.2 | `pcp-agentctl` | In progress | enroll/run/status in [M5.7](M5.7-fleet-ui.md); packaging pending |
| M6.3 | `pcpcontrol` extension (heartbeat, tasks, discovery) | Not started | — |
| M6.4 | OpAMP server and supervisor | Not started | — |
| M6.5 | Ingest gateway | Done | [lookup](M6.5-internal-lookup.md), [gateway](M6.5-ingest-gateway.md) |
| M6.6 | Telemetry query module | Done | [M6.6](M6.6-telemetry-query.md) |
| M6.7 | Installer and systemd units | Done (M6a scope) | [M6.7](M6.7-installer.md); [deploy runbook](../runbooks/deploy-control-plane.md) |
| M6.8 | Host overview UI | Done | [M6.8](M6.8-infrastructure-ui.md) |
| M7.1 | Webhook ingestion framework | Done | [M7-webhooks](M7-webhooks.md) |
| M7.2 | Cloudflare connector | Done | [M7-connectors](M7-connectors.md) |
| M7.3 | GitHub connector | Done | [M7-connectors](M7-connectors.md) |
| M7.4 | Prometheus (Mode A) and Grafana connectors | Done | [M7-connectors](M7-connectors.md) |
| M7.5 | Integrations UI | Done | [M7-web](M7-web.md) |
| M8.1 | Private connector worker | Not started | — |
| M8.2 | Database connectors | Not started | — |
| M8.3 | Custom REST connector and SSRF guard | Not started | — |
| M9.1 | Observation pipeline | Not started | — |
| M9.2 | Correlation rules | Not started | — |
| M9.3 | Graph API and traversal | Not started | — |
| M9.4 | Topology, inventory, review UI | Not started | — |
| M10.1 | Pack schema and loader | Done (code catalog) | [M6b-packs-api](M6b-packs-api.md) |
| M10.2 | Pack compiler | Done | [M6b-agent-packs](M6b-agent-packs.md), [M10-execution-log](M10-execution-log.md) |
| M10.3 | Pack catalog | Done | [M6b-packs-api](M6b-packs-api.md) |
| M10.4 | Detection, proposals, credential delivery | Done | [M6b-discovery](M6b-discovery.md) |
| M10.5 | Level 2 guidance | Done | [M10-execution-log](M10-execution-log.md) |
| M10.6 | Usage and limits UI | Done | [M10-execution-log](M10-execution-log.md) |
| M10.7 | Live boost | Done | [M10-execution-log](M10-execution-log.md) |
| M10.8 | Service dashboards | Done | [M6b-services-ui](M6b-services-ui.md) |
| M11.1 | Live tail | Done | [M11-agent-tail](M11-agent-tail.md), [M11-live-tail-api](M11-live-tail-api.md), [M11-logs-ui](M11-logs-ui.md) |
| M11.2 | Log-derived metrics | Done | [M11-log-metrics](M11-log-metrics.md) |
| M12.1 | Alert rules and compiler | Done | [M12-schema](M12-schema.md), [M12-rule-compiler](M12-rule-compiler.md), [M12-compose](M12-compose.md) |
| M12.2 | Alert receiver and incident engine | Done | [M12-incident-engine](M12-incident-engine.md), [M12-alerting-api](M12-alerting-api.md) |
| M12.3 | Notifications | Done | [M12-notifications-worker](M12-notifications-worker.md) |
| M12.4 | Incident UI | Done | [M12-incidents-ui](M12-incidents-ui.md) |
| M13.1 | Google OAuth framework | Done | [M13b-google](M13b-google.md) |
| M13.2 | GA4 connector | Done | [M13b-google](M13b-google.md) |
| M13.3 | Firebase, Play, Search Console, BigQuery exports | Done (BigQuery exports not read yet) | [M13b-google](M13b-google.md) |
| M13.4 | Google Ads connector (gated on developer token) | Awaiting approval | Needs a Google Ads developer token |
| M13.5 | Website monitoring | Done | [M13a-schema](M13a-schema.md), [M13a-probe](M13a-probe.md), [M13a-worker-alerts](M13a-worker-alerts.md), [M13a-api](M13a-api.md), [M13a-web](M13a-web.md) |
| M13.6 | KPI definitions and freshness | Done | [M13b-google](M13b-google.md) |
| M13.7 | Analytics, ads, website, mobile screens | Done | [M13b-google](M13b-google.md) |
| M14.1 | LLM provider layer | Done | [M14-schema](M14-schema.md), [M14-providers](M14-providers.md) |
| M14.2 | Tool registry | Done | [M14-ai-api](M14-ai-api.md) |
| M14.3 | Orchestration loop and validation | Done | [M14-investigation-loop](M14-investigation-loop.md) |
| M14.4 | Chat UI | Done | [M14-ai-ui](M14-ai-ui.md) |
| M15.1 | Templates and schedules | Done | [M15-schema](M15-schema.md) |
| M15.2 | Report generator | Done | [M15-reports-package](M15-reports-package.md), [M15-worker](M15-worker.md) |
| M15.3 | Delivery | Done | [M15-api](M15-api.md), [M15-web](M15-web.md) |
| M16.1 | Action engine | Done | [M16-schema](M16-schema.md), [M16-engine](M16-engine.md), [M16-api](M16-api.md) |
| M16.2 | Adapters | Done | [M16-engine](M16-engine.md) |
| M16.3 | `pcp-helper` | Done | [M16-helper](M16-helper.md) |
| M16.4 | Approvals UI | Done | [M16-web](M16-web.md) |
| M17.1 | Fleet install UX | Done | [M17-execution-log](M17-execution-log.md) |
| M17.2 | Fleet tooling | Done | [M17-execution-log](M17-execution-log.md) |
| M17.3 | Installer runner (assisted SSH, opt-in) | Done | [M17-execution-log](M17-execution-log.md) |
| M18.1 | Retained logs | Not started | — |
| M18.2 | Data inspection | Not started | — |
| M18.3 | Level 1 managed exporters | Not started | — |
| M18.4 | Long-term rollups | Not started | — |
| M19.1 | Security hardening | In progress | CSP and headers, dependency audit, zod fix done; external pentest pending — [M19 log](M19-execution-log.md) |
| M19.2 | Load tests | Not started | — |
| M19.3 | Backup and restore | Done | [runbook](../runbooks/backup-restore.md) |
| M19.4 | Self-hosted packaging | Not started | — |
| M19.5 | Platform self-monitoring | Done | [runbook](../runbooks/watchdog.md) |
| M19.6 | Documentation | In progress | Runbooks for backup and watchdog; customer and security docs pending |
| M19.7 | Pilot | Not started | — |
| M19.8 | Tenant data export and deletion | Done | [M19 log](M19-execution-log.md) |
