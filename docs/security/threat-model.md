# Threat Model

| | |
|---|---|
| **Scope** | Control plane (web, API, worker, gateways, storage), customer-side agents and workers, connectors, AI layer |
| **Method** | STRIDE per component, plus the spec §18.1 threat catalogue with owning tasks |
| **Sources** | Spec §18, §14.3, §11.5–11.9, §8.6, §8.11; master plan Global Constraints; ADRs 0003–0015 |
| **Review** | Revisit at every milestone exit and before pilot (M19.1) |

## 1. Assets worth protecting

1. Tenant data: configuration, asset graph, telemetry, incidents, reports, AI conversations.
2. Credentials: connector secrets, OAuth refresh tokens, pack credentials (customer side), signing keys, agent CA intermediate, `MASTER_KEY`.
3. Customer infrastructure reachable through agents and connectors.
4. Integrity of operational actions and audit history.

## 2. Trust boundaries

```text
Internet ──► Caddy (TLS, mTLS for agent./ingest.) ──► edge network: web, api
                                                    └► internal network: worker, postgres, redis,
                                                       victoriametrics, victorialogs, vmalert,
                                                       opamp-server, ingest-gateway
Customer network: host agent, pcp-helper (opt-in, root), private connector worker
External providers: Cloudflare, GitHub, Google, LLM providers
```

Boundaries crossed: browser → Caddy; agent → Caddy (mTLS); provider webhook → Caddy; API/worker → providers; API → LLM provider; control plane → agent (signed tasks only).

## 3. STRIDE by component

| Component | Spoofing | Tampering | Repudiation | Information disclosure | Denial of service | Elevation of privilege |
|---|---|---|---|---|---|---|
| Web + API | Session theft → httpOnly/Secure cookies, MFA for admins | Input validation (Zod), CSRF via SameSite + origin checks | Append-only audit log | RLS + route-enumeration tests; 404 for out-of-scope | Rate limits on auth and API | RBAC guard on every route; no client-trusted tenant IDs |
| Control gateway | mTLS + DB revocation | Signed tasks (Ed25519) | Task results stored and audited | Agents never receive other agents' tasks | Long-poll limits, per-agent quotas | Agent identity scoped to its enrollment |
| Ingest gateway | mTLS fingerprint lookup | Label overwrite; size limits | Usage records per agent | Tenant labels set server-side | Series and sample limits, 413/429 | No admin endpoints on ingest host |
| OpAMP server | mTLS | Config compiled and validated by API | Effective-config hash recorded | Config contains no secrets in plaintext | Connection limits | Only API-compiled config delivered |
| Worker | n/a (internal) | Idempotent jobs, deterministic IDs | `job_executions` history | Jobs run inside `withTenant` | Dead letter, retries with backoff | `pcp_scheduler` has only `SECURITY DEFINER` functions |
| PostgreSQL | Network isolation, strong passwords | Migrations by `pcp_migrator` only | Audit rows immutable for `pcp_app` | RLS forced; backups encrypted | Connection pool limits | `pcp_app` has no `BYPASSRLS`, owns no tables |
| Telemetry storage | Internal network only | Writes only from ingest gateway | — | Reads only through tenant query layer | Retention, query limits | No direct access from apps except query layer |
| Host agent | Per-agent certificate | Signed binaries, checksum-verified installer | Heartbeats and task results logged | Never reads env/config secrets; redaction at edge | `memory_limiter`, disk cap | Unprivileged `pcp-agent` user; no shell |
| `pcp-helper` | Unix socket restricted to `pcp-agent` group | Signed tasks, local allowlist | Audit of every execution | — | Single-use tasks | Only allowlisted units/artifacts |
| Private connector worker | mTLS identity | Signed tasks | Results audited | Bounded sanitized results; local secrets | Query timeouts and row limits | Read-only database users |
| Connectors | Provider auth only | Webhook signatures + replay checks | Sync runs recorded | Secrets encrypted, redacted logs | Rate limits, circuit breakers | Least-privilege scopes; read-only by default |
| AI layer | Uses caller's context | Tool outputs validated | `tool_executions` audited | Data-class exclusions; no secrets | Run limits | Tools authorize every call; only proposals |
| Installer runner | Host-key confirmation | Signed install script only | Session audit | No stored credentials | Session TTL 1 h | No shell; cleanup removes access |

## 4. Threat catalogue (spec §18.1)

### Cross-tenant data leak
Impact: critical. Mitigations: RLS forced on every tenant table, transaction-local tenant context, route-enumeration 404 tests, scoped AI tools, tenant labels in telemetry.
Owning tasks: M2.1, M2.2, M2.4, M6.6, M9.3, M14.2, M19.1

### Stolen connector credential
Impact: high. Mitigations: least privilege, envelope encryption with external key, rotation, redaction, audit, crypto-shredding on delete.
Owning tasks: M4.1, M4.2, M7.2, M7.3, M13.1

### Agent impersonation
Impact: high. Mitigations: one-time hashed enrollment tokens, per-agent mTLS certificates, revocation checked within 30 s, header trust only from Caddy.
Owning tasks: M5.1, M5.2, M5.3, M5.6

### Prompt injection in provider data
Impact: high. Mitigations: retrieved content treated as data, strict tool policy, only `proposeAction` writes and it needs approval.
Owning tasks: M14.2, M14.3

### SSRF through custom connector
Impact: high. Mitigations: DNS/IP validation, blocked private and metadata ranges, connect to resolved address, re-validated redirects, size and time limits.
Owning tasks: M8.3

### Arbitrary host execution
Impact: critical. Mitigations: no shell tools anywhere, signed allowlisted tasks, `pcp-helper` opt-in with customer-controlled allowlist, approvals.
Owning tasks: M6.3, M16.1, M16.3, M17.3

### Excessive provider API calls
Impact: medium. Mitigations: per-provider rate limits, quotas, backoff with jitter, `Retry-After`, caching, circuit breakers.
Owning tasks: M4.2, M13.2

### Webhook forgery/replay
Impact: high. Mitigations: per-connection secrets, signature and timestamp checks (5 min), idempotency by delivery ID (7 days).
Owning tasks: M7.1

### Sensitive data sent to LLM
Impact: high. Mitigations: data classification with LLM eligibility, redaction, tenant AI opt-out, sanitized summaries for reports.
Owning tasks: M0.3, M14.1, M14.2, M15.2

### Compromised customer agent
Impact: high. Mitigations: narrow capabilities, unprivileged user, ingest limits, revocation, agent cannot address other tenants or agents.
Owning tasks: M5.5, M5.6, M6.5

### Misconfigured RLS
Impact: critical. Mitigations: integration tests per table, no bypass roles, forced RLS, transaction-local scope, Definition of Done rule.
Owning tasks: M2.1, M2.2

### Supply chain compromise
Impact: high. Mitigations: signed releases (cosign), SBOM, dependency and image scanning, exact version pins, image digests in releases.
Owning tasks: M1.4, M6.1, M19.1

### Cross-tenant telemetry query
Impact: critical. Mitigations: gateway-set tenant labels, query layer `extra_label`/`extra_filters`, storage reachable only on internal network, per-tenant vmalert groups.
Owning tasks: M6.5, M6.6, M12.1

### Tenant floods telemetry / cardinality explosion
Impact: medium. Mitigations: edge label filters and allowlists, per-agent and per-tenant series and sample limits, usage visibility.
Owning tasks: M6.5, M10.2, M10.6

### Secrets or PII in logs
Impact: high. Mitigations: redaction on the host before logs leave it, live tail by default, opt-in retention, no raw logs to LLM.
Owning tasks: M11.1, M18.1

### Exporter exposed on public interface
Impact: medium. Mitigations: managed exporters bind to `127.0.0.1`; discovery detects and warns about publicly bound exporters.
Owning tasks: M6.3, M18.3

### Data-inspection abuse
Impact: high. Mitigations: off by default, Owner/Admin enablement, allowlisted read-only commands, per-use audit, no `MONITOR`/`KEYS *`/value reads.
Owning tasks: M18.2

### Google token theft or over-scoping
Impact: high. Mitigations: PKCE + session-bound state, encrypted refresh tokens, granted-scope tracking, read-only enforcement for `adwords`, no service-account keys.
Owning tasks: M13.1, M13.4

## 5. Additional threats identified during planning

### Assisted-install credential exposure
Impact: high. Mitigations: ephemeral key per session, password memory-only, host-key confirmation, cleanup, fixed egress IPs, no credential columns.
Owning tasks: M17.3

### Pooled connection tenant leak
Impact: critical. Mitigations: `set_config(..., true)` inside a transaction only; tests with pool size 1 and interleaved tenants (Review Focus #1).
Owning tasks: M2.2

### Loss of `MASTER_KEY`
Impact: high (availability). Mitigations: separate key custody, documented key backup, restore drills.
Owning tasks: M19.3

## 6. Residual risks

- Single-node telemetry storage depends on label-based isolation until cluster mode (ADR 0007).
- ADRs and this model are `Proposed` until accepted by the security owner (M0.1).
