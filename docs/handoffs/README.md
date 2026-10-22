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
| M6–M19 | Not started | |

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
| M6.1 | Agent distribution build | Not started | — |
| M6.2 | `pcp-agentctl` | In progress | enroll/run/status in [M5.7](M5.7-fleet-ui.md); packaging pending |
| M6.3 | `pcpcontrol` extension (heartbeat, tasks, discovery) | Not started | — |
| M6.4 | OpAMP server and supervisor | Not started | — |
| M6.5 | Ingest gateway | Done | [lookup](M6.5-internal-lookup.md), [gateway](M6.5-ingest-gateway.md) |
| M6.6 | Telemetry query module | Not started | — |
| M6.7 | Installer and systemd units | Not started | — |
| M6.8 | Host overview UI | Not started | — |
| M7.1 | Webhook ingestion framework | Not started | — |
| M7.2 | Cloudflare connector | Not started | — |
| M7.3 | GitHub connector | Not started | — |
| M7.4 | Prometheus (Mode A) and Grafana connectors | Not started | — |
| M7.5 | Integrations UI | Not started | — |
| M8.1 | Private connector worker | Not started | — |
| M8.2 | Database connectors | Not started | — |
| M8.3 | Custom REST connector and SSRF guard | Not started | — |
| M9.1 | Observation pipeline | Not started | — |
| M9.2 | Correlation rules | Not started | — |
| M9.3 | Graph API and traversal | Not started | — |
| M9.4 | Topology, inventory, review UI | Not started | — |
| M10.1 | Pack schema and loader | Not started | — |
| M10.2 | Pack compiler | Not started | — |
| M10.3 | Pack catalog | Not started | — |
| M10.4 | Detection, proposals, credential delivery | Not started | — |
| M10.5 | Level 2 guidance | Not started | — |
| M10.6 | Usage and limits UI | Not started | — |
| M10.7 | Live boost | Not started | — |
| M10.8 | Service dashboards | Not started | — |
| M11.1 | Live tail | Not started | — |
| M11.2 | Log-derived metrics | Not started | — |
| M12.1 | Alert rules and compiler | Not started | — |
| M12.2 | Alert receiver and incident engine | Not started | — |
| M12.3 | Notifications | Not started | — |
| M12.4 | Incident UI | Not started | — |
| M13.1 | Google OAuth framework | Not started | — |
| M13.2 | GA4 connector | Not started | — |
| M13.3 | Firebase, Play, Search Console, BigQuery exports | Not started | — |
| M13.4 | Google Ads connector (gated on developer token) | Not started | — |
| M13.5 | Website monitoring | Not started | — |
| M13.6 | KPI definitions and freshness | Not started | — |
| M13.7 | Analytics, ads, website, mobile screens | Not started | — |
| M14.1 | LLM provider layer | Not started | — |
| M14.2 | Tool registry | Not started | — |
| M14.3 | Orchestration loop and validation | Not started | — |
| M14.4 | Chat UI | Not started | — |
| M15.1 | Templates and schedules | Not started | — |
| M15.2 | Report generator | Not started | — |
| M15.3 | Delivery | Not started | — |
| M16.1 | Action engine | Not started | — |
| M16.2 | Adapters | Not started | — |
| M16.3 | `pcp-helper` | Not started | — |
| M16.4 | Approvals UI | Not started | — |
| M17.1 | Fleet install UX | Not started | — |
| M17.2 | Fleet tooling | Not started | — |
| M17.3 | Installer runner (assisted SSH, opt-in) | Not started | — |
| M18.1 | Retained logs | Not started | — |
| M18.2 | Data inspection | Not started | — |
| M18.3 | Level 1 managed exporters | Not started | — |
| M18.4 | Long-term rollups | Not started | — |
| M19.1 | Security hardening | Not started | — |
| M19.2 | Load tests | Not started | — |
| M19.3 | Backup and restore | Not started | — |
| M19.4 | Self-hosted packaging | Not started | — |
| M19.5 | Platform self-monitoring | Not started | — |
| M19.6 | Documentation | Not started | — |
| M19.7 | Pilot | Not started | — |
| M19.8 | Tenant data export and deletion | Not started | — |
