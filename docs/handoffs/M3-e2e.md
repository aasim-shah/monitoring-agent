# Handoff — M3 End-to-end journeys

| | |
|---|---|
| **Status** | Done (M3 exit gate met) |
| **Date** | 2026-10-22 |
| **Branch** | `feat/m3-dashboard-shell` |
| **Plan** | Master M3 exit gate; expansion Task 6 |
| **Workbooks** | WB-01; WB-18 J1 (onboarding, first half) |

## Summary

Playwright drives Chromium against the full Compose stack (Caddy, web, API, worker, PostgreSQL, Redis, telemetry services, plus Mailpit for email). Two journeys pass: the complete owner onboarding and the viewer's restricted view. This is the master plan's M3 exit gate.

## Delivered

| Path | Purpose |
|---|---|
| `tests/e2e/compose.e2e.yaml` | Override: Mailpit (`axllent/mailpit:v1.27.10`, API on `127.0.0.1:18225`), `SMTP_URL=smtp://mailpit:1025` for the API |
| `tests/e2e/global-setup.ts` | Writes an env file, `docker compose up --build --wait`, tears down after (`E2E_KEEP_STACK=1` keeps it) |
| `tests/e2e/helpers/` | Mailpit polling, link extraction, TOTP (reuses the API's RFC 6238 implementation), ports |
| `tests/e2e/onboarding.spec.ts` | Sign up → verification email → sign in → create organization → forced MFA setup (Review Focus #2) → 10 recovery codes → FireMaps with domain and repository → Production and Staging → invite (email received) → audit log shows `organization.created`, `product.created`, `environment.created`, `invitation.created` |
| `tests/e2e/navigation.spec.ts` | Owner (API) invites a viewer; the signed-out viewer opens the invitation, is sent through login and back, sees no Settings or Audit Log; typing the settings URL shows "Not found" (Review Focus #3) |
| `.github/workflows/ci.yml` | New `e2e` job (installs Chromium, runs `pnpm test:e2e`, uploads traces on failure) |
| Root script | `pnpm test:e2e` |

## How to run

```bash
pnpm --filter @pcp/tests exec playwright install chromium   # once
pnpm test:e2e                                                # ~7 min first run (image builds), then ~2 min
E2E_KEEP_STACK=1 pnpm test:e2e                               # keep the stack for debugging
```

## Tests

| Run | Result |
|---|---|
| `pnpm test:e2e` | 2 passed |
| Mutation check: inviting the "viewer" as admin | navigation spec fails, as it should (spec restored) |
| Full pipeline | 45/45 Turborepo tasks; repo checks 51; Prettier clean; actionlint clean |

## Decisions

- The journeys run against the real stack, not mocks; only email delivery is replaced, by Mailpit.
- `tests` typechecks with `Bundler` module resolution so Playwright's extensionless imports pass `tsc`.
- These journeys ran green on the first run because they cover screens built test-first in Tasks 2–5; a deliberate mutation proved they detect regressions.

## Known limitations

- Docker builds print `cpu-features install: Error: Unable to detect compiler type`: an optional native module of `ssh2` (pulled by Testcontainers through dockerode) skipped in Alpine. It is only in the build stage and harmless.

## Next

- M4: connector SDK, connection lifecycle, job framework (M4.1 envelope encryption is already in place).
