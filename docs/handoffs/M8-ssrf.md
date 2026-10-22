# Handoff — M8.3 SSRF guard and pinned HTTP client

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-23 |
| **Branch** | `feat/m8-private-worker` |
| **Plan** | M8 plan Task 1 |
| **Workbooks** | WB-07 BR-07-06, TC-07-07..10 |

## Delivered

- `packages/connector-sdk/src/ssrf-guard.ts`: `assertPublicDestination(url, { allowPrivate, allowlist?, lookup? })`.
  - Accepts only http(s), and refuses credentials in the URL.
  - Resolves the host once. Every resolved address must pass, so a hostname that resolves to both a public and a private address is refused.
  - IPv4-mapped IPv6 addresses are normalized before the check.
  - **Blocked for central execution:** `0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`, `192.168/16`, `::`, `::1`, `fc00::/7`, `fe80::/10`.
  - **Private execution** reaches a private address only when its `host` or `host:port` is allowlisted. Link-local and unspecified addresses, which include the metadata service, stay blocked even when allowlisted.
- `createHttpClient({ destination })`:
  - each request is checked by the guard, then sent through an undici `Agent` whose lookup always returns the vetted address, so a second (rebinding) lookup never happens
  - redirects are manual, at most 3, and each is re-checked
  - guard errors are not retried
- New `ConnectorErrorReason` values: `destination_blocked`, `invalid_response`.
- Dependency: `undici` 7.30.1, already in the lockfile.

## Tests

`pnpm --filter @pcp/connector-sdk test`: 39 passed. The 20 new tests cover:
- every blocked range, as an IP literal and through DNS
- a hostname that resolves to mixed addresses
- schemes and URL credentials
- the private allowlist, including the metadata service staying blocked
- rebinding: the lookup is called once, and the connection goes to the vetted address
- a redirect to `169.254.169.254` being blocked
- loopback refused before connecting
