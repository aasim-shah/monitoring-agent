# Handoff — M13a Websites & APIs page

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-23 |
| **Branch** | `feat/m13a-websites` |
| **Plan** | M13a plan Task 5 |
| **Workbooks** | WB-09 UC-09-01/02, §7 |

## Delivered

- **API:** `GET /api/v1/website-monitors/:id/metrics?range=15m|1h|6h|24h|7d` (`telemetry.query`, tenant-scoped). It returns two charts from VictoriaMetrics:
  - response time, in ms (`website_response_seconds`)
  - uptime, in percent (`avg_over_time(website_up)` over at least 2 min)

  OpenAPI `getWebsiteMonitorMetrics`, with the client regenerated.
- **Web page** `products/[productId]/websites`:
  - **Monitor list:** URL, state (Up, Down, Verifying, Paused, or Waiting for first check), status code (or the error when there is no status), response time, days until the certificate expires, and last check. Refreshed every 15 s.
  - **Verification panel** for each unverified or paused monitor:
    - the TXT record name and value, with a copy button
    - "Check verification", which names the domains checked when the record is not found
    - A paused monitor shows its reason. Verifying it again resumes it.
  - **Add dialog:** http(s) URLs only and an interval of 30–3600 s, checked before the API is called.
  - **Delete.**
  - **Charts:** response time and uptime for the selected monitor (picked from the list, otherwise the first active one), with ranges 1h, 6h, 24h, and 7d.
  - **Permissions:** managing needs `pack.manage`; viewers only see the list.
- **Format:** a new `ms` unit (`245 ms`, `1.84 s`).
- **Nav:** "Websites & APIs" is enabled for `telemetry.query`.

## Tests

- **API:** `website-metrics.int.test.ts`. With the other website tests, 5/5 pass.
- **Web:** `components/websites/websites.test.tsx` (4):
  - the list states, latency, and TLS days
  - the TXT instructions and the check result
  - no management actions for viewers
  - add-dialog validation
- **Also:** the `ms` unit format test and the nav test. The web suite passes 147/147.
