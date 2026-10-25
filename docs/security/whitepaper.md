# Security overview

Audience: a customer's security reviewer. This summarises how the Product Control Plane protects customer data; the detailed analysis is the [threat model](threat-model.md) and [data classification](data-classification.md).

## Architecture in one paragraph

A multi-tenant web application (Next.js dashboard, NestJS API, PostgreSQL, Redis, workers) behind Caddy. Customer servers run an outbound-only agent (OpenTelemetry Collector distribution plus a small control client) that sends metrics to an ingest gateway and receives signed tasks. Provider data comes through connectors with the customer's credentials. Telemetry lives in VictoriaMetrics (and, if enabled, VictoriaLogs), separated per tenant by labels and account IDs that only the platform sets.

## Tenant isolation

- **PostgreSQL:** every tenant table uses forced row-level security. Every query runs inside a transaction that sets the tenant. A test suite checks that each tenant table has a policy and that tenant A sees none of tenant B's rows.
- **Telemetry:** the ingest gateway overwrites `tenant_id`, `product_id`, `environment_id`, and `agent_id` from the agent's certificate. The only read path adds `extra_label=tenant_id` and product filters, so a query cannot widen its own scope.
- **Retained logs:** stored under the tenant's VictoriaLogs AccountID. Searches always run with the caller's AccountID and product.
- **API:** every denial is a 404, so it never reveals whether another tenant's resource exists.

## Identity and access

- **Sign-in:** email and password (Argon2id) with mandatory TOTP for owners, Google sign-in, or the customer's own OIDC provider. Sessions are server-side and revocable.
- **Roles:** owner, admin, operator, analyst, and viewer, optionally scoped to products. Approving production actions, exporting data, and deleting the organization are owner-only.
- **Audit:** every security-relevant change is recorded in an append-only audit log (who, what, when, request id).

## Secrets

- **Encryption:** connector credentials and MFA secrets use envelope encryption with per-tenant data keys under the platform master key. They are decrypted only in memory, when a connector runs.
- **Pack credentials:** sealed in the browser to the target agent's X25519 key and deleted from the platform once the agent acknowledges them.
- **Assisted SSH installs:** keys, passwords, and enrollment tokens are held in the installer runner's memory only. No database column can hold one.

## Agents

- **Outbound only:** agents need no inbound port.
- **Identity:** each agent has its own key and a 30-day client certificate from the platform's intermediate CA, rotated automatically. A revoked agent is refused within 30 seconds.
- **Signed tasks:** tasks are signed (Ed25519), expire, and are single-use. The agent runs no shell.
- **Privileged actions:** service restarts and exporter installs go through the optional `pcp-helper`. It acts only for units and exporters the server owner allowlisted in a root-owned file the platform cannot change.

## Data minimisation

- **Logs:** live tail and retained logs are redacted on the customer's server before they leave it (tokens, passwords, emails, card numbers). Raw logs never go to the AI.
- **Data inspection:** reads statistics (counts, sizes, lag), never values. Kafka message peek is a separate, allowlisted, audited opt-in. Peeked messages are shown for 10 minutes and never stored.
- **Labels:** high-cardinality and personal labels (user ids, session ids, full URLs) are dropped by the agent.

## AI

- **Inputs:** the assistant and report summaries receive tool results and snapshots, never raw logs, secrets, or inspection values.
- **Answers:** every number in a generated summary is checked against the evidence. Unverifiable summaries are not sent.
- **Opt-out:** customers can turn AI off per organization. Self-hosted operators can run a local model or no AI at all.

## Operations

- **Backups:** nightly verified database backups, kept 14 days, with a monthly restore drill.
- **Monitoring:** an independent watchdog alerts operators by email. Security headers (CSP, HSTS, and others) are set on every page.
- **Dependencies:** scanned in CI (`pnpm audit`, govulncheck, and secret scanning).
- **Releases:** agent releases are checksummed, and the installer refuses a tarball whose checksum does not match. Managed exporters are pinned by checksum inside the helper.

## Customer controls

- **Export:** owners can export all their data (without secrets) through a 24-hour download link.
- **Deletion:** deleting an organization starts a 30-day grace period. After it, the data is purged and encryption keys are destroyed.

## Not yet done

- **External testing:** an external penetration test is planned before general availability. Results and remediations will be shared on request.
- **Uptime commitments:** no numeric SLO is published until load-test baselines exist (spec §19.2).
