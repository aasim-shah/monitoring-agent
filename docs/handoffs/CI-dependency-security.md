# Handoff — CI dependency and secret scan fixes

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-22 |
| **Branch** | `feat/m3-dashboard-shell` (first commit) |
| **Trigger** | First GitHub CI run on `main` (run 39746537992): 6/8 jobs passed; `osv-scan` and `secret-scan` failed |

## Findings and fixes

| Finding | Severity | Fix |
|---|---|---|
| turbo 2.5.8 | 9.8 | → 2.11.10 |
| tinypool 1.1.1, @vitest/mocker, vitest 3.2.7 | 9.5 / 5.9 | Vitest → 4.1.12 everywhere |
| nodemailer 6.10.1 (13 advisories) | up to 8.3 | → 10.2.0 (`@types/nodemailer` 8.0.2); API unchanged for our use |
| deepmerge-ts 7.1.5 (pinned by Prisma) | 8.2 | override → 8.0.0; database tests (migrate, RLS, drift) green |
| uuid 10.0.0, undici 5.29.0, @fastify/busboy (Testcontainers) | up to 7.5 | Testcontainers → 11.14.0; `dockerode>uuid` override → 11.1.1 |
| postcss 8.4.31 (pinned by Next 15.5.28) | up to 7.5 | override `next>postcss` → 8.5.31 |
| fastify 5.11.3 (pinned by Nest) | 5.9 | override → 5.12.7; direct dependency bumped |
| ajv 8.17.1 | 5.5 | → 8.20.0 |
| braces 3.0.3 | 8.7 | No fixed release. Dev-only (eslint, fast-glob); never in production images; patterns are repository-controlled. Ignored in `osv-scanner.toml` until 2027-01-31 with this reason |
| gitleaks `generic-api-key` in `packages/agent-protocol/src/validate.test.ts` | false positive | Fixture now `'x'.repeat(24)`; historical finding listed in `.gitleaksignore` |

## Verification (local, same tool versions as CI)

| Check | Result |
|---|---|
| `osv-scanner` (action image v2.7.0) | No issues (1 documented ignore) |
| `gitleaks` 8.24.3 over full history | No leaks |
| `pnpm turbo run build lint typecheck test --force` | 45/45 tasks |
| `pnpm test:smoke` | 12/12 |

## Decisions

- ADR 0002 updated: security fixes take precedence over the preference for known majors; overrides and ignores are the documented escape hatches.

## Follow-up

- `actions/checkout@v4` triggers a Node 20 deprecation annotation; upgrade actions in a separate change.
