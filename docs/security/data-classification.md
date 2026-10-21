# Data Classification

Each data class from spec §11.1 with its storage, sensitivity, retention default, and whether it may enter LLM context. "LLM eligible" means the data may be passed to an LLM provider inside tool results or report summaries; tenants can further restrict this (WB-14).

| Data class | Examples | Storage | Sensitivity | Default retention | LLM eligible |
|---|---|---|---|---|---|
| Configuration | Connections (non-secret config), schedules, policies | PostgreSQL | Internal | Life of tenant | Yes, without secret fields |
| Asset graph | Resources, relationships, evidence | PostgreSQL | Internal | Life of tenant | Yes |
| High-rate metrics | CPU, request rate, latency | VictoriaMetrics / customer Prometheus | Internal | 15 days raw, 13 months rollups | Yes, as bounded aggregates |
| Logs | Application and system logs | Live tail (not stored); opt-in VictoriaLogs | Confidential (may contain PII) | Not stored; 7 days if retained | Redacted samples and counts only; never raw logs |
| Traces | Request spans and dependencies | Customer backends; hosted later | Internal | Per backend | Aggregates only |
| Aggregated KPIs | Daily users, spend, uptime | PostgreSQL | Internal / business confidential | Per retention policy | Yes |
| Incident timeline | Alerts, deployments, annotations | PostgreSQL | Internal | Life of tenant | Yes |
| AI conversations | Messages, tool run metadata | PostgreSQL | Confidential | 90 days | Yes (same tenant, same conversation) |
| Secrets | Provider credentials, refresh tokens | Encrypted PostgreSQL / customer-side | Restricted | Until deleted (crypto-shredded) | Never |

## Additional classes

| Data class | Storage | Sensitivity | LLM eligible |
|---|---|---|---|
| Data-inspection results (Redis/Kafka stats, message peek) | Not stored (audit record only) | Restricted | Counts and sizes only; never values or messages |
| Personally identifiable user records | Never collected by default | Restricted | Never |
| Source code contents | Never collected | Restricted | Never |
| Environment variables | Never collected | Restricted | Never |
| Audit logs | PostgreSQL (append-only) | Internal | Summaries only |

## Rules

1. Collect only needed operational metadata (spec §18.2).
2. Redact secrets and PII at the earliest point: on the host for logs, before storage for observations.
3. Anything marked "Never" is blocked by the AI tool executor, not only by convention (M14.2 tests).
