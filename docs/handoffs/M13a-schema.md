# Handoff — M13a Website monitors schema (migration 0009)

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-23 |
| **Branch** | `feat/m13a-websites` |
| **Plan** | M13a plan Task 1 |

## Delivered

- **`website_monitors`**, with RLS forced:

  | Column group | Fields |
  |---|---|
  | Target | URL and host |
  | Settings | interval (default 60 s); expected status (null means any 2xx or 3xx) |
  | Verification | verification token; `verified_at` and `verification_checked_at` |
  | State | `pending_verification`, `active`, or `paused`, with a reason |
  | Last probe | checked at, up, status code, error, total ms, consecutive failures, TLS expiry and issuer |

  One monitor per URL per organization.
- **`pcp_resolve_website_monitor(id, user)`** returns the organization and product, for members only. The tenant guard uses it.
- **`JOB_KINDS`** gains `website-probe` (entity = monitor). Its handler is injected by the worker.

## Tests

- **Database:** RLS covers the new table, and the resolver answers members only. 98 tests pass and the schema-drift check is clean.
- **Jobs package:** typecheck passes.
