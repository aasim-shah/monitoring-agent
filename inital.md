# MASTER ENGINEERING PROMPT
# Self-Hosted AI Product Control Plane

## Your Role

Act as a Principal Software Architect, Staff Backend Engineer, Senior Frontend Engineer, Platform Engineer, Security Architect, and AI Agent Systems Engineer.

Your objective is to design and implement a production-grade, self-hosted AI Product Control Plane.

This is not simply an AI chatbot, monitoring dashboard, or analytics aggregator.

It is a unified product ecosystem discovery, observability, intelligence, automation, and operations management platform.

The platform must be deployable on a Linux VPS using Docker Compose and must provide a complete self-hosted web dashboard.

Prioritize maintainable architecture, reliable integrations, secure credential management, clear operational boundaries, and production-level correctness.

Do not fabricate integrations, API capabilities, telemetry, or execution results.

## 1. Core Product Concept

Users create a Product Workspace representing an entire digital product.

A product can include:

- Websites and landing pages
- Web applications
- Mobile applications
- Mobile SDKs
- Backend APIs
- VPS servers
- Cloud infrastructure
- Docker containers
- Databases
- DNS providers
- CDN providers
- Authentication providers
- Analytics services
- Advertising platforms
- Git repositories
- CI/CD pipelines
- External APIs
- Third-party data providers
- Scheduled jobs
- Background workers
- Monitoring services
- Email services
- Storage providers
- Payment services
- Webhook integrations

The platform must discover authorized resources, understand their relationships, monitor operational health, analyze product activity, and provide actionable insights.

It must maintain a unified, continuously updated product knowledge graph.

## 2. Example Product: FireMaps

A customer creates a product named FireMaps.

FireMaps has:

- Public website
- React/Next.js web application
- Android application
- iOS application
- Mobile SDK integrations
- Backend API services
- Multiple VPS servers
- Regional data-processing workers
- External geospatial data providers
- MongoDB database
- Cloudflare DNS and CDN
- GitHub repositories
- GitHub Actions deployments
- Firebase projects
- Google Analytics properties
- Google Ads accounts
- Prometheus servers
- Node Exporter instances
- Grafana dashboards
- Email delivery service

The platform should represent these as connected assets.

It should identify dependencies, ownership, health, configuration changes, operational incidents, and business activity.

A failure in a backend service should allow impact analysis across dependent websites, mobile applications, SDK consumers, and processing jobs.

## 3. Technical Stack

Use:

Frontend:
- Next.js
- React
- TypeScript
- Tailwind CSS
- shadcn/ui
- TanStack Query
- React Flow for interactive topology visualization
- Recharts
- React Hook Form
- Zod

Backend:
- NestJS with Fastify
- TypeScript
- PostgreSQL
- Prisma
- Redis
- BullMQ
- OpenAPI

AI:
- Provider-agnostic LLM interface
- OpenAI API
- Anthropic API
- OpenAI-compatible local endpoints
- Structured tool calling
- Zod tool validation
- Conversation persistence
- Context retrieval from authorized product resources

Collectors:
- Go-based lightweight host collector
- OpenTelemetry instrumentation
- Prometheus-compatible metrics

Deployment:
- Docker Compose
- Caddy reverse proxy
- Persistent volumes
- Health checks
- Environment configuration
- Secure secrets handling

Use a TypeScript monorepo.

Implement the API as a modular monolith.

Run background workers independently.

Do not introduce Kubernetes or Kafka into the MVP.

## 4. Platform Modules

Implement these modules:

1. Identity and Access Management
2. Organization Management
3. Product Workspace Management
4. Environment Management
5. Integration Registry
6. Connector Execution Engine
7. Resource Discovery Engine
8. Asset Inventory
9. Product Knowledge Graph
10. Dependency Correlation Engine
11. Infrastructure Observability
12. Application Observability
13. Business Analytics Aggregation
14. AI Agent Orchestrator
15. Tool Registry
16. Workflow Automation
17. Job Scheduling
18. Alerting and Incident Management
19. Reporting Engine
20. Notification Engine
21. Controlled Action Execution
22. Security and Audit Management

Keep modules independent through explicit interfaces and dependency injection.

## 5. Product Workspace

Each organization can have multiple products.

Each product can have multiple environments.

Example:

Organization: Example Company

Product: FireMaps

Environments:
- Production
- Staging
- Development

A workspace must provide:

- Product overview
- Connected integrations
- Asset inventory
- Dependency graph
- Infrastructure health
- Application analytics
- Business KPIs
- Active incidents
- AI assistant
- Automated reports
- Scheduled workflows
- Operational actions
- Audit history

All data access must be tenant-scoped.

## 6. Integration Framework

Create a connector SDK.

Each connector must support applicable capabilities:

- Authentication
- Connection validation
- Resource discovery
- Resource synchronization
- Health checking
- Metrics querying
- Event ingestion
- Webhook registration
- Credential refresh
- Configuration validation
- Controlled operations

Not every connector supports every capability.

Use explicit capability declarations.

Connector capabilities should be discoverable by the UI and AI tool registry.

The connector registry must support adding new connectors without modifying the central orchestration logic.

Implement versioned connector contracts.

Provide integration contract tests.

## 7. Required Integrations

### Cloudflare

Support scoped API tokens.

Discover:
- Zones
- DNS records
- Relevant routing configuration
- Available analytics
- Security rules where authorized

Monitor:
- DNS configuration changes
- Available traffic analytics
- Security events
- Relevant certificate status

Management:
- DNS updates
- Cache purge
- Restricted configuration changes

All modifications require explicit authorization.

### GitHub

Prefer GitHub App installation authentication.

Discover:
- Repositories
- Branches
- Workflows
- Deployments
- Releases
- Relevant repository metadata

Monitor:
- Workflow failures
- Deployment activity
- Release changes
- Repository events

Management:
- Trigger allowlisted workflows after approval

Do not expose repository secrets to the LLM.

### VPS and Host Collector

Build a lightweight Go collector.

The collector must support outbound registration to the control plane.

Use per-agent identity and authenticated communication.

Discover:
- Host metadata
- Operating system
- Running services
- Docker containers
- Selected listening ports
- Configured application metadata
- Monitoring exporters

Monitor:
- CPU
- RAM
- Disk
- Network
- Service health
- Container health
- Heartbeat status

Avoid collecting environment variable values, private files, or application secrets.

Do not execute arbitrary shell commands.

Future action execution must use a strict allowlist and approval policy.

### Prometheus

Connect through the HTTP API.

Discover:
- Targets
- Available metrics
- Selected labels
- Alerting metadata where supported

Support:
- Instant queries
- Range queries
- Metric templates
- Server monitoring
- Application monitoring
- Database monitoring

Protect against excessive query cost.

### Grafana

Discover:
- Dashboards
- Folders
- Dashboard metadata

Associate Grafana dashboards with product assets.

Support secure links to Grafana.

Do not treat Grafana as the primary metric storage system.

### Google Analytics 4

Support authorized OAuth and service account access.

Discover accessible properties.

Query:
- Users
- Sessions
- Events
- Traffic sources
- Engagement
- Key events
- Geographic data

Support historical comparisons.

Respect quotas and reporting freshness.

### Firebase

Support Firebase project metadata and authorized service-specific integrations.

Include:
- Firebase Authentication
- Firebase Analytics through linked GA4 properties
- Supported crash reporting sources
- Supported Google Cloud Monitoring metrics

Do not assume historical authentication events are automatically available.

### Google Ads

Implement OAuth and developer token configuration.

Discover accessible accounts.

Query:
- Campaigns
- Spend
- Clicks
- Impressions
- Conversions
- Performance trends

Read-only in the MVP.

### Databases

Support:
- PostgreSQL
- MongoDB
- MySQL

Provide:
- Connection validation
- Metadata discovery
- Health checks
- Storage statistics
- Read-only aggregate business metrics

Enforce read-only credentials and query limits.

### Websites

Support:
- HTTP uptime probes
- TLS certificate checks
- Redirect validation
- Response-time measurement
- Optional browser synthetic checks
- Optional frontend telemetry SDK
- Deployment metadata integration

Do not claim to discover internal architecture solely from a public website URL.

### Mobile Applications

Support mobile integrations through:
- Firebase
- Analytics APIs
- Crash reporting providers
- Optional first-party telemetry SDK
- CI/CD and release metadata

Track:
- Application versions
- Crash signals
- Session analytics
- API dependencies
- SDK dependencies
- Release changes

### Custom REST APIs

Allow users to configure:
- Base URL
- Authentication
- Endpoints
- Request parameters
- Pagination
- Response mappings
- Sync intervals
- Metric extraction

Enforce SSRF protection, timeouts, response size limits, and outbound network policies.

### Webhooks

Implement:
- Signed incoming webhooks
- Replay protection
- Event validation
- Idempotency
- Delivery tracking
- Retry processing
- Dead-letter handling

## 8. Resource Discovery Engine

Implement an automated discovery system.

Discovery sources:
- Provider APIs
- Host collectors
- Repository metadata
- DNS records
- Deployment configuration
- Application telemetry
- OpenTelemetry traces
- Explicit user-provided asset definitions

Each discovery operation must create structured observations.

Observations include:
- Source
- Resource identity
- Provider
- Resource type
- Attributes
- Timestamp
- Discovery method
- Evidence
- Confidence

Normalize observations into canonical assets.

Deduplicate assets using provider identity, resource type, environment, and validated correlation rules.

Do not merge unrelated resources based only on matching names.

Track resource lifecycle:
- Discovered
- Active
- Unreachable
- Missing
- Retired
- Manually managed

Support periodic rediscovery.

Retain historical observations.

## 9. Product Knowledge Graph

Represent product dependencies using assets and directed relationships.

Relationship types:
- DEPENDS_ON
- ROUTES_TO
- DEPLOYED_ON
- CONNECTS_TO
- MONITORED_BY
- AUTHENTICATES_WITH
- USES_SDK
- PRODUCES_DATA_FOR
- OWNED_BY
- TRIGGERED_BY

Each relationship must include:
- Source asset
- Target asset
- Type
- Confidence
- Verification status
- Supporting evidence
- Last observed timestamp

Provide:
- Interactive graph visualization
- Asset filtering
- Environment filtering
- Relationship inspection
- Dependency traversal
- Impact analysis
- Manual confirmation
- Manual correction

Use PostgreSQL for graph persistence initially.

Do not introduce Neo4j unless performance requirements justify it.

## 10. Observability Engine

Support:
- Infrastructure metrics
- Application metrics
- HTTP availability
- Logs through supported providers
- Distributed traces
- Business events
- Deployment events
- Configuration changes

Normalize metrics with:
- Source
- Resource
- Timestamp
- Unit
- Metric type
- Dimensions
- Collection status

Keep high-frequency telemetry in its native observability backend.

Persist selected aggregates and operational snapshots in PostgreSQL.

Support freshness indicators and missing-data detection.

## 11. AI Orchestrator

Implement a tool-calling AI agent.

The agent must have access to authorized tools such as:

- listProducts
- listAssets
- getAssetDetails
- getAssetDependencies
- getAffectedServices
- getIntegrationHealth
- getInfrastructureMetrics
- getApplicationMetrics
- getAnalyticsMetrics
- getDatabaseHealth
- getDeploymentHistory
- getRecentIncidents
- compareMetrics
- generateOperationalReport
- proposeOperationalAction

Each tool must enforce tenant isolation and role permissions.

Validate tool inputs and outputs.

Apply query timeouts and result-size limits.

The LLM must not directly access unrestricted databases, SSH, cloud credentials, or shell execution.

Implement source-backed answers.

Every significant finding must include:
- Evidence source
- Reporting period
- Relevant resource
- Observed metrics
- Confidence or uncertainty
- Suggested investigation

## 12. AI Operational Knowledge

Maintain an operational context layer containing:
- Asset inventory
- Product topology
- Service descriptions
- Environment metadata
- Integration capabilities
- Monitoring definitions
- Historical incidents
- Recent deployments
- Report history
- Operational runbooks

Use structured retrieval first.

Add semantic retrieval for unstructured runbooks and documentation only when needed.

Do not use vector embeddings as a substitute for authoritative asset relationships.

## 13. Automated Daily Reports

Allow users to configure daily reports by:
- Product
- Environment
- Timezone
- Schedule
- Selected integrations
- Metrics
- Notification channels
- Recipients

Report sections:
- Executive summary
- Product health
- Infrastructure performance
- Application performance
- User analytics
- Database health
- Advertising performance
- Recent deployments
- Security and availability events
- Significant anomalies
- Suggested actions
- Data coverage and missing sources

Generate reports from structured, validated snapshots.

Use the LLM for narrative analysis.

Perform numerical calculations deterministically.

Store reports and delivery history.

## 14. Alerting and Incidents

Implement:
- Threshold alerts
- Availability alerts
- Integration failure alerts
- Missing-data alerts
- Metric-change alerts
- Deployment-related alerts

Support:
- Severity
- Deduplication
- Acknowledgment
- Resolution
- Notification cooldown
- Escalation
- Incident timeline
- Related assets
- Potential impact

Correlate alerts using the product knowledge graph.

Do not claim causal relationships without supporting evidence.

## 15. Workflow Automation

Use BullMQ and Redis.

Support:
- Scheduled integration synchronization
- Resource discovery
- Credential health checks
- Alert evaluation
- Daily report generation
- Notification delivery
- Data retention cleanup
- Approved operational workflows

Persist schedule definitions in PostgreSQL.

Use deterministic job identifiers.

Support retries, dead-letter queues, concurrency controls, and distributed locking.

Ensure jobs survive application restarts.

## 16. Operational Action Engine

Create a separate action subsystem.

Action lifecycle:
1. Propose action
2. Validate target asset
3. Validate permissions
4. Validate action policy
5. Estimate impact
6. Request approval
7. Execute through restricted adapter
8. Verify result
9. Record audit event
10. Report outcome

Initial actions may include:
- Cloudflare cache purge
- Trigger approved GitHub Actions workflow
- Restart allowlisted Docker service
- Run predefined maintenance workflow

Disable operational actions by default.

Never permit unrestricted AI-generated shell commands.

Implement idempotency and concurrency protection.

## 17. Dashboard

Create these primary sections:

- Overview
- Products
- Environments
- Integrations
- Asset Inventory
- Dependency Topology
- Infrastructure
- Applications
- Analytics
- Databases
- AI Assistant
- Incidents
- Automation
- Reports
- Actions
- Settings
- Audit Logs

Use professional SaaS dashboard patterns.

Implement real loading, error, empty, and disconnected states.

Do not use fake operational metrics.

## 18. Security

Implement:
- Secure authentication
- RBAC
- Tenant isolation
- Encrypted connector secrets
- External master encryption key
- OAuth state validation
- Least-privilege credentials
- TLS validation
- SSRF protection
- Webhook signature validation
- Rate limiting
- Audit logging
- Secret redaction
- Secure collector identity
- Approval-controlled operations
- Prompt injection defenses
- Credential rotation
- Backup and restore

Treat connector responses and retrieved documents as untrusted.

Ensure the LLM cannot bypass tool authorization.

## 19. Docker Deployment

Provide a working Docker Compose deployment with:

- web
- api
- worker
- postgres
- redis
- caddy

Use persistent volumes.

Provide health checks.

Do not expose databases or Redis publicly.

Support configurable application ports.

Support private HTTP bootstrap and production HTTPS.

Provide an environment template.

Provide backup and restore documentation.

Document how to deploy collectors to remote servers.

## 20. Database Schema

Implement Prisma models for:

User
Organization
Membership
Product
Environment
ConnectorDefinition
Connection
ConnectionSecret
Asset
AssetObservation
AssetRelationship
DiscoveryRun
DiscoveryEvidence
Collector
CollectorHeartbeat
MetricDefinition
MetricAggregate
BusinessEvent
Incident
AlertRule
ChangeEvent
Conversation
Message
AgentRun
ToolExecution
JobDefinition
JobExecution
ReportTemplate
GeneratedReport
NotificationChannel
NotificationDelivery
ActionPolicy
ActionRequest
ActionApproval
ActionExecution
AuditLog

Use UUID primary keys, foreign keys, unique constraints, and tenant-aware indexes.

## 21. Testing

Implement:
- Unit tests
- Connector contract tests
- API integration tests
- Worker execution tests
- Authentication tests
- Tenant isolation tests
- OAuth callback tests
- Webhook verification tests
- AI tool authorization tests
- Dependency graph tests
- Action approval tests
- Docker deployment smoke tests
- End-to-end dashboard tests

Use mock provider adapters for automated tests, clearly separated from production connectors.

## 22. Implementation Order

Phase 1:
- Monorepo
- Docker
- Authentication
- Organizations
- Products
- Environments
- Dashboard shell

Phase 2:
- Connector SDK
- Connection lifecycle
- Secure credentials
- Cloudflare connector
- GitHub connector
- Prometheus connector

Phase 3:
- Asset discovery
- Asset normalization
- Relationship evidence
- Knowledge graph
- Topology dashboard

Phase 4:
- Host collector
- Infrastructure monitoring
- Website monitoring
- Metrics aggregation
- Health dashboard

Phase 5:
- GA4
- Firebase
- Database connectors
- Business analytics

Phase 6:
- AI orchestration
- Tool registry
- Chat interface
- Incident investigation
- Source-backed responses

Phase 7:
- Alerting
- Daily reports
- Email delivery
- Automation workflows

Phase 8:
- Action policies
- Approval workflows
- Restricted action execution
- Verification and auditing

Phase 9:
- Security hardening
- Load testing
- Documentation
- Backup and restore
- Release packaging

## 23. Acceptance Criteria

The platform is ready for its initial production pilot when:

1. It installs successfully on a clean Linux VPS.
2. An administrator can create a product workspace.
3. Real provider connections can be configured securely.
4. Cloudflare resources can be discovered through authorized APIs.
5. GitHub repositories and workflows can be discovered.
6. Prometheus metrics can be queried.
7. Assets and dependencies appear in the topology graph.
8. Discovery evidence and confidence are visible.
9. A host collector can report server health.
10. The dashboard displays real operational data.
11. The AI agent can answer questions using authorized tools.
12. The AI agent identifies missing evidence rather than inventing findings.
13. Scheduled reports execute and are delivered.
14. Alerts are generated from actual conditions.
15. Tenant isolation and RBAC tests pass.
16. Container restarts preserve configuration and schedules.
17. Secrets are encrypted and excluded from logs.
18. Operational actions require explicit policy authorization.
19. All critical integration and end-to-end tests pass.

## 24. Coding Agent Instructions

Do not attempt to implement the entire platform in one unverified code generation pass.

First produce:
- Architecture decision records
- System component diagram
- Database schema
- Connector contracts
- Asset identity strategy
- Discovery lifecycle
- API contracts
- Security model
- Deployment architecture
- Milestone plan

Then implement one milestone at a time.

For each milestone:
1. Define acceptance criteria.
2. Implement backend functionality.
3. Implement frontend functionality.
4. Add tests.
5. Validate real integration behavior where credentials are available.
6. Document limitations.
7. Confirm milestone completion before proceeding.

Never silently replace a required production integration with mock data.

Never invent API endpoints or provider capabilities.

Use official provider documentation and supported SDKs.

Prioritize correctness, reliability, security, and maintainability over feature count.

The final result must be a deployable, extensible, self-hosted AI Product Control Plane capable of becoming a commercial multi-tenant SaaS platform.