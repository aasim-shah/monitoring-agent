# Handoff — M8.3 Custom REST connector

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-23 |
| **Branch** | `feat/m8-private-worker` |
| **Plan** | M8 plan Task 3 |
| **Workbooks** | WB-07 UC-07-07..09, BR-07-06 |

## Delivered

`@pcp/connectors-custom-http` (`type: custom-http`). It runs in both cloud and private execution.

**Config:**
- **Required:** `baseUrl` and 1–20 `endpoints`. Each endpoint has `name` and a relative `path` (`/…`, never `//` or absolute). Optional fields:
  - `query`
  - `itemsPath`
  - `pagination { param, start, max ≤ 100 }`
  - `metrics [{ name, path | '$count', unit? }]`
- **Auth:** `none`, `api_key_header` (`headerName`, default `X-API-Key`), or `bearer`.
- **Credential field:** `token`.

**Security:**
- Every request goes through the SSRF guard: one DNS resolution, a pinned connection, and redirects checked again.
- `allowPrivate` and `allowlist` apply only when `executionLocation === 'private'`. Central execution always blocks private targets, whatever the config says.

**Bounds:** 1 MB responses, a 10 s timeout, one retry, and 100 pages.

**Behaviour:**
- `validate` calls the first endpoint and requires JSON.
- `health().data.endpoints[]` returns `{ name, status, pages, metrics, warnings }` for each endpoint:
  - A metric that is missing or not a number is `null` with a warning, never 0.
  - Pagination that runs past `max` stops and adds the warning `stopped after N pages`.
- **Errors:**
  - 401 → `reauthorization_required`
  - 403 → `permission_denied`
  - non-JSON → `invalid_response`, naming the content type and never quoting the body
  - the token is redacted from every message
- `readPath` is a minimal JSONPath: `$`, `.key`, `['key']`, `[n]`.

**Ruling:** values come back through `health.data` rather than `collect`, because `MetricQuery` is PromQL-shaped. KPI storage is M13.

## Tests

`pnpm --filter @pcp/connectors-custom-http test`: 7 passed. Covered:
- path reading
- metric mapping, with `null` and a warning for a missing value
- HTML gives `invalid_response`
- pagination stops at `max`; `max > 100` is rejected
- a cloud execution against `127.0.0.1` is refused even with an allowlist
- a wrong token never appears in the error
- absolute and protocol-relative paths are rejected
