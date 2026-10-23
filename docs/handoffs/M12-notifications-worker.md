# Handoff — M12.3 Notifications and worker evaluation

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-23 |
| **Branch** | `feat/m12-alerts` |
| **Plan** | M12 plan Task 5 |
| **Workbooks** | WB-13 UC-13-03/05/07/09/10, BR-13-05 |

## Delivered

- **`packages/notifications`:**
  - `sign` and `verify` implement the documented algorithm `t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>` with 300 s tolerance.
  - `render(event, incident, link)` produces the email subject, text and HTML, the Slack text, and the webhook JSON.
  - **`processDelivery(prisma, ctx, id, final, deps)`:**
    - **Email** goes through `deps.sendMail`. **Slack and webhook** go through the connector SDK client with SSRF pinning, no retries of its own, a 10 s timeout, and a 64 KB limit.
    - **Success** marks the delivery `sent` and resets the channel (a broken channel becomes active again).
    - **Failure** marks it `failed` and rethrows, so BullMQ retries it (5 attempts, backoff from 10 s).
    - **Final failure** marks it `dead`. After 3 dead deliveries in a row, a Slack or webhook channel becomes `broken`.
- **`packages/alerting/tick.ts`, `tick(tx, org, now)`:**
  - **`agent_heartbeat_missing`** checks active host agents in the rule's product whose last heartbeat (or enrollment) is older than N minutes. Revoked agents never fire, and their open incidents resolve.
  - **`connection_degraded`** checks connections in the product's resource scopes (or all, for an organization-wide rule) that have been `degraded` for N minutes, using `updated_at`.
  - The results run through `ingest`, followed by `escalate`.
- **Worker:**
  - `alerting-handlers.ts` handles `alert-tick` (tick, then `createDeliveries`, then queue each delivery) and `notification-deliver` (`processDelivery`, final on the 5th attempt).
  - `main.ts` passes these handlers to `startProcessors` and builds nodemailer with 10 s timeouts. Without `SMTP_URL`, email deliveries fail visibly.
  - New config: `SMTP_URL`, `MAIL_FROM` (default `Product Control Plane <alerts@localhost>`), and `APP_ORIGIN`.
- **Customer docs:** `docs/integrations/webhook-signature.md`, with Node.js and Python verification.

## Tests

- **`notifications`, 10 tests:**
  - TC-13-08 (signature verifies; stale, changed, or wrong ones are rejected)
  - rendering
  - email, signed webhook, and Slack deliveries
  - 500 errors retried, then dead, the channel broken after 3, and a successful test reactivating it
  - a private destination refused with no request made
  - a deleted channel skipped
- **`alerting/tick.int.test.ts`, 4 tests:**
  - a silent agent opens an incident and a heartbeat resolves it
  - a revoked agent never alerts and its incident resolves
  - a degraded connection over the limit
  - escalation after 15 minutes, once
- **`worker`:**
  - config (6 tests)
  - the handlers (Postgres plus Redis): a silent agent leads to a queued delivery and then the email "[CRITICAL] Agent heartbeat missing on vps-1 — opened"
