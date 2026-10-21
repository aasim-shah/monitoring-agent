# Feature Workbooks — AI Product Control Plane

Workbooks describe every feature area as use cases, flows, rules, data, interfaces, edge cases, tests, tasks, and acceptance criteria. They sit between the architecture spec and the code:

- **Spec** (`AI_Product_Control_Plane_Architecture_and_Flows.md`) — what the system is and why.
- **Master plan** (`docs/superpowers/plans/2026-10-21-ai-product-control-plane.md`) — milestones, decisions, pinned values, shared contracts.
- **Workbooks** (this folder) — how each feature behaves for users and systems, and how we prove it.

If a workbook conflicts with the spec or the master plan, the spec and the plan win; fix the workbook.

## Conventions

| Prefix | Meaning | Example |
|---|---|---|
| `WB-NN` | Workbook | WB-11 Monitoring packs |
| `UC-NN-MM` | Use case MM in workbook NN | UC-11-02 Enable a pack with sealed credentials |
| `BR-NN-MM` | Business rule | BR-04-02 Gateway overwrites tenant labels |
| `TC-NN-MM` | Test case | TC-10-06 Product-scoped analyst sees only own services |
| `J<n>` | End-to-end journey (WB-18) | J3 API latency incident |
| `M<n>.<k>` | Master-plan task | M10.4 Detection, proposals, credential delivery |
| `D<n>` | Master-plan decision | D17 vmalert tenancy |

Every workbook uses the same sections: purpose and scope, actors, use cases, flows, business rules, data, API, screens, edge cases, security, test cases, task checklist, acceptance criteria, open items.

## Personas

| Persona | Typical role | Goals |
|---|---|---|
| Founder / CTO | Owner | See product health and business KPIs in one place; trust the numbers |
| DevOps lead | Admin | Connect everything quickly and safely; control who can do what |
| On-call engineer | Operator | Detect, understand, and resolve incidents fast |
| Product / growth analyst | Analyst | Analytics and ads performance for assigned products |
| Stakeholder | Viewer | Read dashboards and reports |
| Customer server admin | (no platform role needed) | Install agents with minimal access and risk |
| Approver | Owner/Admin per policy | Approve safe operational actions with clear impact |
| Platform operator | Vendor SRE | Run, upgrade, back up, and secure the platform |
| Enterprise operator | Self-hosted customer | Run the platform inside their own infrastructure |

## Workbook index

| Workbook | Area | Milestones | Use cases |
|---|---|---|---|
| [WB-01](WB-01-accounts-organizations-access.md) | Accounts, organizations, products, access | M2, M3 | 17 |
| [WB-02](WB-02-connector-framework-secrets.md) | Connector framework, connections, secrets | M4 | 11 |
| [WB-03](WB-03-agent-enrollment-identity-fleet.md) | Agent enrollment, identity, fleet | M5, M6.2, M6.4, M17.1 | 11 |
| [WB-04](WB-04-host-agent-telemetry-pipeline.md) | Host agent and telemetry pipeline | M6 | 10 |
| [WB-05](WB-05-agent-installation-methods.md) | Agent installation methods | M6.7, M17 | 11 |
| [WB-06](WB-06-cloud-integrations-webhooks.md) | Cloudflare, GitHub, Prometheus, Grafana, webhooks | M7 | 11 |
| [WB-07](WB-07-private-worker-databases-custom-rest.md) | Private worker, databases, custom REST | M8 | 9 |
| [WB-08](WB-08-google-integrations.md) | Google integrations | M13.1–M13.4 | 12 |
| [WB-09](WB-09-websites-kpis-freshness.md) | Websites, KPIs, freshness | M13.5–M13.7 | 8 |
| [WB-10](WB-10-discovery-knowledge-graph.md) | Discovery and knowledge graph | M9 | 12 |
| [WB-11](WB-11-monitoring-packs-service-monitoring.md) | Monitoring packs and service monitoring | M10, M18.3 | 12 |
| [WB-12](WB-12-logs-data-inspection.md) | Logs and data inspection | M11, M18.1, M18.2 | 8 |
| [WB-13](WB-13-alerts-incidents-notifications.md) | Alerts, incidents, notifications | M12 | 11 |
| [WB-14](WB-14-ai-assistant-investigations.md) | AI assistant and investigations | M14 | 10 |
| [WB-15](WB-15-reports-schedules.md) | Reports and schedules | M15 | 9 |
| [WB-16](WB-16-operational-actions-approvals.md) | Operational actions and approvals | M16 | 11 |
| [WB-17](WB-17-platform-operations.md) | Platform operations, self-hosting, backups, security | M1, M19 | 13 |
| [WB-18](WB-18-end-to-end-journeys.md) | End-to-end journeys | Exit gates | 7 journeys |

## Milestone → workbook map

| Milestone | Workbooks |
|---|---|
| M0 Contracts and decisions | All (ADRs and contracts referenced everywhere) |
| M1 Monorepo, CI, Compose | WB-17 |
| M2 Identity, tenancy, RLS, RBAC, audit | WB-01 |
| M3 Dashboard shell | WB-01 |
| M4 Secrets, connector SDK, lifecycle, jobs | WB-02 |
| M5 Control gateway, enrollment, identity | WB-03 |
| M6 Host agent, OpAMP, ingest, VictoriaMetrics | WB-03, WB-04, WB-05 |
| M7 Cloud connectors and webhooks | WB-06 |
| M8 Private worker, databases, custom REST | WB-07 |
| M9 Discovery, graph, topology | WB-10 |
| M10 Monitoring packs | WB-11 |
| M11 Logs | WB-12 |
| M12 Alerting, incidents, notifications | WB-13 |
| M13 Google, websites, KPIs | WB-08, WB-09 |
| M14 AI orchestrator | WB-14 |
| M15 Reports | WB-15 |
| M16 Actions | WB-16 |
| M17 Installation methods | WB-03, WB-05 |
| M18 Retained logs, inspection, Level 1, rollups | WB-11, WB-12, WB-16 |
| M19 Hardening, self-hosted, pilot | WB-17, WB-18 |

## Review Focus traceability

| Review Focus | Test cases |
|---|---|
| #1 Pooled connections leak tenant context | TC-01-13 |
| #2 Agent reconnect after long offline | TC-03-09, TC-04-04, TC-04-05 |
| #3 DST-day daily report | TC-15-01, TC-15-02, TC-15-03 |
| #4 Partial Google consent / revoked token | TC-08-03, TC-08-05 |
| #5 Shared host across products | TC-10-06 |

## Cross-workbook open items

| Item | Workbook | Proposed resolution |
|---|---|---|
| Organization/product deletion and tenant data export | WB-01, WB-17 | Master plan task M19.8 |
| Loki/Elasticsearch log connectors (spec §11.8) | WB-06, WB-12 | Post-pilot backlog |
| Duplicate-connection policy | WB-02 | Warn, do not block |
| Agent disk cap default | WB-04 | 1 GB, confirm with pilot hosts |
| Default approver roles per environment | WB-16 | Owner/Admin production, Operator staging |
| Keyless Google service-account mode timing | WB-08 | Post-pilot unless required |
| Auto-upgrade channels for agents | WB-03 | Manual upgrades for pilot |

## Keeping workbooks current

- Update the workbook in the same pull request as the behavior change.
- New endpoints in a workbook must also be added to `docs/architecture/openapi-v1.yaml` (M0.4).
- Mark a use case `Deprecated` instead of deleting it, so test and journey references stay valid.
