# Handoff — M13a Website monitors API and AI tool

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-23 |
| **Branch** | `feat/m13a-websites` |
| **Plan** | M13a plan Task 4 |
| **Workbooks** | WB-09 UC-09-01/02, BR-09-01/02 |

## Delivered (`apps/api/src/modules/websites`)

- **Routes:**

  | Route | Permission | What it does |
  |---|---|---|
  | `GET /api/v1/products/:id/website-monitors` | `telemetry.query` | Lists the product's monitors. |
  | `POST /api/v1/products/:id/website-monitors` | `pack.manage` | Creates a monitor and schedules its `website-probe` job. Returns the `verification` record. |
  | `POST /api/v1/website-monitors/:id/verify` | `pack.manage` | Checks the TXT record now. Returns `{verified, checkedNames}`. |
  | `DELETE /api/v1/website-monitors/:id` | `pack.manage` | Deletes the monitor and its job. |

  - **Create rules:**
    - The URL must be http or https and resolve to a public address (checked with the injected DNS resolver).
    - The interval is 30–3600 s (default 60).
    - At most 50 monitors per organization; a duplicate URL gives 409.
  - **The `verification` record** is `{record: 'TXT', name: host, value: 'pcp-verify=<token>'}`.
  - All changes are audited (`website_monitor.*`).
- **Tenant guard:** the `website_monitor` resource uses `pcp_resolve_website_monitor`. `TXT_RESOLVER` defaults to `dns.resolveTxt` and can be replaced in tests (`createTestApp({ txt })`).
- **AI tool `getWebsiteAvailability`:** now real. Per monitor it returns:
  - state and paused reason
  - the last probe: up, status, response time, error, consecutive failures
  - TLS expiry in days
  - uptime percent over the window (`avg_over_time(website_up)`), with a gap when telemetry is unavailable

  It links to Websites & APIs, and says "no websites are monitored" when there are none. The fake provider routes "website" questions to this tool.
- **OpenAPI:** the `WebsiteMonitor` schema and the four routes (tag `websites`). The API client was regenerated.

## Tests

`websites.int.test.ts` (4) covers:
- create, the scheduled job, verification on a parent domain, list, and delete, with the job and audit rows
- refusing private targets, invalid URLs, a 10 s interval, and the 51st monitor
- viewers read but cannot manage, and another tenant gets 404
- the AI tool reporting the last probe and the TLS expiry

The AI tests still pass (5).
