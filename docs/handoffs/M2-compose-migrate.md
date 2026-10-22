# Handoff — M2 deployment: migrate service, smoke, OpenAPI

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-22 |
| **Branch** | `feat/m2-identity-tenancy` |
| **Plan** | Expansion `2026-10-22-m2-identity-tenancy.md` Task 8 |
| **Workbooks** | WB-17 (UC-17-01, UC-17-04) |

## Summary

The Compose stack now runs database migrations before the API starts and connects the API as the least-privileged `pcp_app` role. Smoke tests prove, in both deployment modes, that migrations succeed and sign-up works end to end through Caddy. OpenAPI documents request and response schemas for all 24 routes delivered in M2.

## Delivered

| Change | Detail |
|---|---|
| `migrate` service | `packages/database/Dockerfile`; runs `pcp-db migrate` once: role bootstrap as superuser `postgres`, then `prisma migrate deploy` as `pcp_migrator` |
| `postgres` | Superuser is `postgres` (`POSTGRES_SUPERUSER_PASSWORD`); database `pcp` |
| `api` | Connects as `pcp_app`; depends on `migrate` completing successfully; gets `MASTER_KEY`, `APP_ORIGIN`, `SMTP_URL`, `MAIL_FROM`; image installs `openssl` for Prisma's musl engine |
| `.env.example` | New required secrets: `POSTGRES_SUPERUSER_PASSWORD`, `PCP_MIGRATOR_PASSWORD`, `PCP_APP_PASSWORD`, `PCP_SCHEDULER_PASSWORD`, `MASTER_KEY`; optional `SMTP_URL`, `MAIL_FROM`, `APP_ORIGIN` |
| `apps/api/src/config.ts` | Empty environment values are treated as unset (Compose passes `""` for `${VAR:-}`) |
| `docs/architecture/openapi-v1.yaml` | 25 component schemas, 4 error responses; every M2 operation marked `x-implemented-in: M2` with its real status codes |
| `README.md` | "Run the stack locally" section |

## Upgrade note (existing M1 stacks)

The PostgreSQL superuser changed from `pcp` to `postgres`. An existing `pg-data` volume from M1 keeps the old superuser; remove it (`docker compose down -v`) before starting M2. M1 stored no data.

## How to verify

```bash
pnpm test:smoke     # 12 pass: secrets required, no published storage ports, both modes healthy,
                    # migrate exited 0, sign-up 202 through Caddy, bootstrap refusals, Caddy configs
```

## Tests

| Test | Result |
|---|---|
| Compose refuses to start without `POSTGRES_SUPERUSER_PASSWORD`, `PCP_APP_PASSWORD`, `MASTER_KEY` | pass |
| No published ports except Caddy (now including `migrate`) | pass |
| Stack healthy in `managed` and `self_hosted` | pass |
| `migrate` exited 0; `POST /api/v1/auth/signup` → 202 through Caddy | pass (both modes) |
| Config treats empty optional values as unset | pass |
| Spectral | 0 errors |

## Decisions

- CI needs no change: integration tests already run in the `node` job, and `ubuntu-24.04` runners provide Docker for Testcontainers.

## Next

- M3: dashboard shell (sign-in, organization/product/environment screens) on top of these APIs.
