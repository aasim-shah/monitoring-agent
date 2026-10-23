# Handoff — M12.1 Alerting schema (migration 0007)

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-23 |
| **Branch** | `feat/m12-alerts` |
| **Plan** | M12 plan Task 1 |
| **Workbooks** | WB-13 §6 |

## Delivered

- **Tables, with RLS forced:**

  | Table | Purpose |
  |---|---|
  | `alert_rules` | Template plus params, severity, enabled. A null product makes the rule organization-wide. |
  | `alert_incidents` | Fingerprint and `open_fingerprint`, status, labels, correlation, summary, and the acknowledge/resolve/notify/escalate timestamps |
  | `incident_events` | The timeline |
  | `notification_channels` | Email, Slack, or webhook. Secrets are envelope-encrypted. Status is `active` or `broken`, with a consecutive-failure count. |
  | `notification_deliveries` | Each delivery and its status |

- **One unresolved incident per fingerprint:** the nullable `open_fingerprint` carries a unique constraint `(organization_id, open_fingerprint)`. The engine sets it to null on resolve. Prisma cannot express a partial index, so this replaces it.
- **Functions:**
  - `pcp_alerting_orgs()` (scheduler role) returns the organizations with enabled rules or open critical incidents.
  - `pcp_resolve_alert_rule_org(rule)` (app role) returns the organization that owns a rule; the receiver uses it.

## Tests

- `alerting.int.test.ts` covers both functions and the one-open-incident constraint.
- `rls.int.test.ts` covers forced RLS and isolation for the 5 new tables.
- The schema-drift check is clean.
