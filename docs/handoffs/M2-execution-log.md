# Execution Log — M2 Identity, Tenancy, RLS, RBAC, Audit

| | |
|---|---|
| **Plan** | `docs/superpowers/plans/2026-10-22-m2-identity-tenancy.md` |
| **Branch** | `feat/m2-identity-tenancy` (stacked on `feat/m0-m1-foundation` at `6ec9e94`) |
| **Executed** | 2026-10-22, inline (superpowers:executing-plans), test-first |

## Ledger

```text
# SDD ledger — plan: docs/superpowers/plans/2026-10-22-m2-identity-tenancy.md
Spec: AI_Product_Control_Plane_Architecture_and_Flows.md v1.1 + master plan + WB-01; branch feat/m2-identity-tenancy stacked on feat/m0-m1-foundation (user chose to continue development; M0/M1 branch kept as-is).
Pre-flight: T1 produces Prisma client + DB roles consumed by T2 (withTenant) and T3–T7 — consistent; T2 can()/withTenant consumed by T5 guard — consistent; T3 SessionService/RateLimiter consumed by T4 — consistent; T5 TenantGuard consumed by T6/T7 — consistent.
Ruling: membership product scope stored as all_products boolean + product_ids uuid[] on organization_members; separate role_assignments table not created — Prisma scalar lists cannot be nullable and one role per member covers spec §2.1 — cost if wrong: one migration if multi-role members are needed.
Ruling: SECURITY DEFINER functions owned by NOLOGIN BYPASSRLS role pcp_rls_definer (FORCE RLS would otherwise filter owner-run definer functions); pcp_app stays NOBYPASSRLS — cost if wrong: none.
Ruling: Postgres test helper exported as @pcp/database/testing (testcontainers devDependency) and Redis helper in @pcp/test-support, avoiding a database↔test-support build cycle — cost if wrong: none.
Ruling: packages/secrets (master M4.1) pulled into M2 Task 3 because TOTP secrets must be encrypted — cost if wrong: none; M4.1 shrinks.
Task 1: Ruling: pcp_migrator granted CREATE on database (prisma migrate deploy runs CREATE SCHEMA IF NOT EXISTS) — cost if wrong: migrator can create schemas.
Task 1: Ruling: _prisma_migrations REVOKE guarded by to_regclass because the shadow DB lacks that table — cost if wrong: none.
Task 1: complete (commits 6ec9e94..eb59b2d, tests: pnpm --filter @pcp/database test →    Duration  12.41s (transform 153ms, setup 0ms, collect 1.57s, tests 18.63s, environment 0ms, prepare 938ms))
Task 2: Ruling: withTenant signature takes the Prisma client as first argument (master §4.1 omitted it) — cost if wrong: none.
Task 2: Ruling: operator 'limited' configuration = agent.enroll + pack.manage, not connection.configure — cost if wrong: one matrix line.
Task 2: complete (commits eb59b2d..0e47fc4, tests: pnpm turbo run test --filter @pcp/tenant-security →   Time:    9.405s )
Task 3: complete (commits 0e47fc4..c479f3a, tests: pnpm turbo run test --filter @pcp/secrets --filter @pcp/api →   Time:    175ms >>> FULL TURBO)
Task 4: Ruling: without SMTP_URL the mailer logs only the subject and sends nothing (bodies carry tokens; logs must not) — cost if wrong: dev sign-up needs an SMTP sink.
Task 4: Ruling: API trusts X-Forwarded-For (trustProxy) because only Caddy reaches it on the edge network — cost if wrong: spoofed IPs could evade per-IP rate limits if the API were exposed directly.
Task 4: complete (commits c479f3a..44449e6, tests: pnpm turbo run test --filter @pcp/api →   Time:    246ms >>> FULL TURBO)
Task 5: Ruling: added migration 0002 pcp_resolve_environment_product (environment routes need product scope) — cost if wrong: none.
Task 5: complete (commits 44449e6..e61a567, tests: pnpm turbo run test --filter @pcp/api --filter @pcp/database →   Time:    184ms >>> FULL TURBO)
Task 6: Ruling: explicit audit.record inside service transactions instead of an interceptor (atomic with the change) — cost if wrong: each new mutation must call record (reviewed per task).
Task 6: Ruling: apps/api declaration:false to stop TS2742 on Prisma-returning methods — cost if wrong: none (app is not a library).
Task 6: complete (commits e61a567..b087a90, tests: pnpm turbo run test --filter @pcp/api →   Time:    240ms >>> FULL TURBO)
Task 7: Ruling: single error code role_above_actor for invites and member changes (plan named role_above_inviter for invites) — cost if wrong: one code rename.
Task 7: complete (commits b087a90..6b60df8, tests: pnpm turbo run test --filter @pcp/api →   Time:    237ms >>> FULL TURBO)
Task 8: Ruling: config treats empty env values as unset (Compose passes '' for ${VAR:-}); found via smoke, fixed test-first — cost if wrong: none.
Task 8: Ruling: Postgres superuser renamed pcp→postgres; old M1 volumes must be recreated (documented upgrade note) — cost if wrong: one down -v on dev stacks.
Task 8: complete (commits 6b60df8..df8ef60, tests: sh -c 'pnpm test:repo && pnpm lint:openapi && pnpm test:smoke' →    Duration  278.13s (transform 81ms, setup 0ms, collect 101ms, tests 277.28s, environment 0ms, prepare 217ms))
Final review: self-review (session policy: no subagents unless the user asks)
Final: fixed Important — Google sign-in linked to an unverified password account kept an attacker-set password (account pre-hijacking) — test "discards a password set on an unverified account before linking it" RED→GREEN, suite 41/41 turbo tasks (api 75/75)
Final: minor (deferred): CurrentUserGuard queries pcp_user_memberships on every request to enforce owner/admin MFA enrollment; cache per session once traffic warrants.
Final: minor (deferred): SessionService.resolve writes last_seen_at on every request; throttle to once per minute.
```

## How to resume

- Next milestone: M3 (dashboard shell). Expand master-plan M3 into a step plan first.
- Prerequisites: `corepack enable`, Docker running (integration tests use Testcontainers).
