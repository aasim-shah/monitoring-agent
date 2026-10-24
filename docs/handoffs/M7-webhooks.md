# Handoff — M7.1 Webhook ingestion framework

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-24 |
| **Branch** | `feat/m7-integrations` |
| **Plan** | M7 plan Tasks 1–2 |
| **Workbooks** | WB-06 §7.7, UC-06-10, UC-06-11, BR-06-05 |

## Delivered

- **Migration 0012:**
  - Tables `webhook_deliveries`, `change_events`, and `connection_inventory`, all with forced RLS.
  - `pcp_webhook_connection(uuid)` (SECURITY DEFINER) resolves a connection's organization before the tenant is known.
- **`POST /webhooks/:provider/:connectionId`** (public):
  - The connector verifies the raw body signature.
  - Every refusal gives the same 401 `invalid_signature` body: unknown connection, wrong provider, disconnected, bad signature, or another connection's secret. Each refusal is audited as `webhook.rejected`.
  - A repeated delivery ID answers 200 `{duplicate:true}` and stores nothing.
  - A new delivery answers 202 `{accepted:true, changeEvents:n}`.
  - Revocation events (GitHub `github_app_authorization` revoked) move the connection to `revoked`.
- **SDK contract:** `verifyWebhook(req, credentials)` and `ingestEvent(ctx, {eventType, headers, payload})`. Shared helpers: `safeEqual`, `hmacSha256Hex`, and `bodyDigest`.
- **Caddy:** `/webhooks/*` goes to the API in the production, behind-proxy, and local configs. Bootstrap still refuses with 503 until HTTPS is configured.
- **Read endpoints** (`connection.view`): `GET /api/v1/connections/:id/webhook-deliveries`, `/change-events`, and `/inventory`.

## Verify

```bash
pnpm --filter @pcp/api exec vitest run src/modules/webhooks
pnpm --filter @pcp/tests exec vitest run smoke/caddy.test.ts
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://monitor.aasimshah.com/webhooks/github/00000000-0000-0000-0000-000000000000   # 401
```

## Decisions

- Webhooks are processed in the request, with no queue. Events are small and normalization writes a few rows.

## Limitations

- No per-source rate limit beyond the API's global limiter.
