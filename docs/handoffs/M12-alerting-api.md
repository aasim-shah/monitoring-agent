# Handoff — M12.2 Alerting API (rules, receiver, incidents, channels)

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-23 |
| **Branch** | `feat/m12-alerts` |
| **Plan** | M12 plan Task 4 |
| **Workbooks** | WB-13 §7, UC-13-01/02/06/08/09/11, BR-13-06/08 |

## Delivered (`apps/api/src/modules/alerting`)

- **Rules:**
  - Routes: `GET/POST /api/v1/products/:id/alert-rules`, `POST …/alert-rules/recommended` (idempotent), `PATCH/DELETE /api/v1/alert-rules/:id`.
  - The list includes the templates.
  - **On every change:**
    1. The organization's rules are compiled with `compileTenant`.
    2. The file is written atomically to `ALERT_RULES_DIR/tenant-<org>.yaml`.
    3. `POST VMALERT_URL/-/reload` is called. A failure is only logged, because vmalert re-reads the files every minute.
    4. The `alert-tick` job definition (60 s, entity = organization) is upserted, enabled while any rule is enabled.
  - Every change is audited (`alert_rule.*`).
- **Receiver:** `POST /internal/alertmanager/api/v2/alerts` (`@Internal`: `X-Internal-Token`, 401 without it).
  - The tenant comes from the `tenant_id` label and must own `rule_id` (`pcp_resolve_alert_rule_org`); otherwise the alert is dropped and logged.
  - The compiler's labels are stripped before fingerprinting. An `endsAt` in the past means resolved; the zero time means firing.
  - Each tenant is ingested in its own context. Deliveries are then created (`createDeliveries`) and queued as `notification-deliver`.
- **Incidents:**
  - `GET /api/v1/products/:id/incidents?status=active|open|acknowledged|resolved|all` returns up to 100, newest first.
  - `GET /api/v1/incidents/:id` returns `{incident, events, correlation, changes: [], sourceLinks}`. The links point to the server page, the host asset, and the alert rules.
  - `POST …/acknowledge` (409 when not open), `POST …/resolve` with `{note}` (409 when already resolved), and `PATCH …/postmortem` with `{summary, causeCategory, followUps}`. All three are audited.
- **Channels:**
  - `GET/POST /api/v1/organizations/:orgId/notification-channels`, `PATCH/DELETE /api/v1/notification-channels/:id`, and `POST …/:id/test` (202, queues a `test` delivery).
  - **Email** takes 1–10 recipients.
  - **Slack and webhook** URLs must be https and pass `assertPublicDestination` (with the DNS resolver injected). The URL is envelope-encrypted with AAD `notification-channel:<id>`.
  - **Webhook signing secret:** a 32-byte base64url value, returned once.
  - The list shows only the target host.
- **Guard and permissions:**
  - New tenant resources `alert_rule`, `incident`, and `notification_channel`, resolved through `pcp_resolve_alerting_object`. Incidents carry their product, so product-scoped members only see their own.
  - Permissions: `incident.view` to read, `incident.manage` for rules and incidents, `org.settings.manage` for channels (admin and owner).
- **Jobs:**
  - `JOB_KINDS` gains `alert-tick` and `notification-deliver`.
  - `startProcessors` takes `handlers` for them; the worker provides those in Task 5.
- **OpenAPI:** typed schemas `AlertRule`, `AlertRuleList`, `AlertTemplate`, `Incident`, `IncidentDetail`, and `NotificationChannel`, plus the new routes. The API client was regenerated.

## Tests

`alerting.int.test.ts` (8 tests) covers:
- rule create, compile, reload, disable, and delete, with the file contents and the audit count
- unknown template or parameter, and the viewer gets 404
- recommended rules are idempotent and the tick is scheduled
- the receiver token
- a forged tenant is dropped
- an incident opens, an email delivery is pending, another organization gets 404, and an alert resolve resolves the incident
- acknowledge, resolve, and postmortem, with product scope and audit
- channel secrets are encrypted and shown once, and private or `http` targets are refused
- a test delivery is queued, and an operator cannot manage channels

The assets, discovery, internal, and jobs suites stay green.
