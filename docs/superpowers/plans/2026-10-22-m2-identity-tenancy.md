# M2 Identity, Tenancy, RLS, RBAC, Audit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver master-plan M2: PostgreSQL schema with forced row-level security and least-privilege roles, tenant context and permission checks, authentication (password, email verification, reset, Google login, TOTP MFA, sessions, rate limits), organizations/products/environments APIs behind an RBAC guard, append-only audit log, members and invitations — proven by RLS, pooled-connection, and route-enumeration cross-tenant tests.

**Architecture:** `packages/database` owns the Prisma schema, hand-written SQL migrations (tables, RLS policies, helper and `SECURITY DEFINER` functions), role bootstrap, and a migrate CLI. `packages/tenant-security` owns the role matrix, `can()`, and `withTenant()`. `packages/secrets` (pulled forward from M4.1) encrypts TOTP secrets. `packages/test-support` starts PostgreSQL and Redis with Testcontainers for integration tests. The API gains `identity`, `tenants`, `products`, `environments`, `members`, `auditing` modules, a `TenantGuard`, and `@RequirePermission` / `@TenantScope` decorators.

**Tech Stack:** existing M0/M1 stack plus Prisma 6.19.3 (`prisma-client-js`, custom output), Testcontainers 10.28.0 (`@testcontainers/postgresql`, `@testcontainers/redis`), `@node-rs/argon2` 2.2.2, jose 5.10.0, nodemailer 6.10.1, `@fastify/cookie` 11.1.3.

**Spec:** `AI_Product_Control_Plane_Architecture_and_Flows.md` §2, §2.1, §6.1–6.2, §14.1–14.4, §15.1, §18; master plan M2.1–M2.6, D7, D8, D9, §3 (sessions, invitations, auth rate limit, MFA), §4.1, §4.7, Review Focus #1; workbook `docs/workbooks/WB-01-accounts-organizations-access.md`; ADR 0003, 0004.

## Global Constraints

- All master-plan Global Constraints apply.
- `pcp_app` has no `BYPASSRLS`, owns no table, and cannot `UPDATE`/`DELETE` `audit_logs`.
- Every tenant table has `ENABLE` and `FORCE ROW LEVEL SECURITY`.
- Tenant context is set only with `set_config(name, value, true)` inside a transaction.
- Out-of-scope or cross-tenant resource access returns **404** (never 403).
- Values from §3: sessions idle 12 h / absolute 7 days; invitations 7 days single use; auth rate limit 10 requests/min/IP; MFA required for `owner` and `admin`; OAuth state TTL 10 min.
- Tokens (session, email, invitation, recovery codes) are stored only as SHA-256 hashes.
- Passwords use argon2id (memory 19 456 KiB, time cost 2, parallelism 1).

## Review Focus

1. **Pooled connection carries previous tenant context.** Expected: never. Test in Task 2 (`with-tenant.int.test.ts`).
2. **Account enumeration on sign-up, login, and reset.** Expected: identical responses for existing and unknown emails. Tests in Task 4.
3. **Last owner removed or demoted.** Expected: rejected with `last_owner`. Test in Task 7.
4. **Cookie flags in bootstrap HTTP mode.** Expected: `Secure` omitted only when `BOOTSTRAP_MODE=private_http`; otherwise always set. Test in Task 4.
5. **A new route without `@RequirePermission`.** Expected: route-enumeration test fails naming it. Test in Task 5.

---

### Task 1: Database package, roles, RLS, migrate CLI (master M2.1)

**Files:**
- Create: `packages/database/{package.json,tsconfig.json,tsconfig.build.json,vitest.config.ts}`, `packages/database/prisma/schema.prisma`, `packages/database/prisma/migrations/{migration_lock.toml,0001_identity_tenancy/migration.sql}`, `packages/database/src/{index,client,bootstrap,migrate,cli}.ts`
- Create: `packages/test-support/{package.json,tsconfig.json}`, `packages/test-support/src/{postgres,redis,index}.ts`
- Test: `packages/database/src/rls.int.test.ts`, `packages/database/src/schema-drift.int.test.ts`

**Interfaces:**
- Produces (`@pcp/database`): `createPrismaClient(url: string): PrismaClient`; re-exports `PrismaClient`, `Prisma`; `TENANT_TABLES: readonly string[]`; `bootstrapRoles(superuserUrl: string, passwords: { migrator: string; app: string; scheduler: string }): Promise<void>`; `migrate(opts: { superuserUrl: string; migratorUrl: string; passwords }): Promise<void>`; CLI `pcp-db migrate`.
- Produces (`@pcp/test-support`): `startPostgres(): Promise<{ superuserUrl: string; migratorUrl: string; appUrl: string; stop(): Promise<void> }>` (container `postgres:17.6-alpine`, roles bootstrapped, migrations applied); `startRedis(): Promise<{ url: string; stop(): Promise<void> }>` (`redis:7.4.6-alpine`).
- Database roles: `pcp_migrator` (LOGIN, owns tables), `pcp_app` (LOGIN, NOBYPASSRLS), `pcp_scheduler` (LOGIN, EXECUTE on scheduler functions only), `pcp_rls_definer` (NOLOGIN, BYPASSRLS, owns `SECURITY DEFINER` functions).
- Tables: `users`, `sessions`, `email_tokens`, `mfa_recovery_codes`, `organizations`, `organization_members`, `invitations`, `products`, `environments`, `teams`, `audit_logs`.
- Tenant tables (RLS): `organizations` (policy on `id`), `organization_members`, `invitations`, `products`, `environments`, `teams`, `audit_logs`.
- Functions: `pcp_current_org() returns uuid`, `pcp_current_user() returns uuid`, `pcp_user_memberships(p_user uuid)`, `pcp_find_invitation(p_token_hash text)`, `pcp_resolve_product_org(p_product uuid, p_user uuid)`, `pcp_resolve_environment_org(p_environment uuid, p_user uuid)`.

- [x] **Step 1: Failing tests** — `rls.int.test.ts`: as `pcp_app` without context every tenant table returns 0 rows; with org A context only A rows; inserting a `products` row for org B under org A context throws (`new row violates row-level security policy`); `rolbypassrls` is false for `pcp_app`; `pcp_app` owns no relation; `organization_members` rows of the current user are visible via `pcp_user_memberships` without org context. `schema-drift.int.test.ts`: `prisma migrate diff --from-migrations … --to-schema-datamodel … --exit-code` exits 0.
- [x] **Step 2: Run** — `pnpm --filter @pcp/database test` → FAIL (modules missing).
- [x] **Step 3: Implement** schema, migration SQL, bootstrap, migrate CLI, test-support.
- [x] **Step 4: Run** → PASS.
- [x] **Step 5: Handoff + commit** — `docs/handoffs/M2.1-database-rls.md`; `git commit -m "feat(database): add schema, roles, RLS, migrate CLI (M2.1)"`.

### Task 2: Tenant security — role matrix, can(), withTenant() (master M2.2)

**Files:**
- Create: `packages/tenant-security/{package.json,tsconfig.json,tsconfig.build.json,vitest.config.ts}`, `packages/tenant-security/src/{role-matrix,permissions,with-tenant,index}.ts`
- Test: `packages/tenant-security/src/permissions.test.ts`, `packages/tenant-security/src/with-tenant.int.test.ts`

**Interfaces:**
- Consumes: `TenantContext`, `Role`, `Permission` (`@pcp/shared-contracts`); `PrismaClient` (`@pcp/database`).
- Produces: `ROLE_PERMISSIONS: Record<Role, readonly Permission[]>`; `can(ctx: TenantContext, permission: Permission, scope?: { productId?: string }): boolean`; `withTenant<T>(prisma: PrismaClient, ctx: TenantContext, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>` (sets `app.organization_id` and, for user actors, `app.user_id`; timeout 15 s).
- Matrix (spec §2.1): `connection.configure` owner+admin; `policy.manage` owner+admin; `action.approve` owner only by default (policy may extend, M16); `org.members.manage` owner+admin; analyst read permissions only; viewer read-only (`org.view`, `product.view`, `connection.view`, `agent.view`, `asset.view`, `telemetry.query`, `incident.view`, `report.view`).

- [x] **Step 1: Failing tests** — `permissions.test.ts`: each spec §2.1 column matches; analyst with `productIds: ['p1']` → `can(ctx,'asset.view',{productId:'p2'}) === false` and `p1` true; unknown role grants nothing. `with-tenant.int.test.ts` (Review Focus #1): pool `connection_limit=1`, run `withTenant(A)` then `$queryRaw` outside a transaction → `current_setting('app.organization_id', true)` is empty and `products` returns 0 rows; 50 interleaved A/B transactions with `connection_limit=5` never read the other tenant's rows; an error thrown inside `withTenant` leaves the next borrower clean.
- [x] **Step 2: Run** → FAIL.
- [x] **Step 3: Implement.**
- [x] **Step 4: Run** → PASS.
- [x] **Step 5: Handoff + commit** — `docs/handoffs/M2.2-tenant-security.md`; `git commit -m "feat(tenant-security): add role matrix, can, withTenant (M2.2)"`.

### Task 3: Identity primitives — secrets, passwords, TOTP, tokens, sessions, rate limiter (master M2.3 part 1, M4.1 pulled forward)

**Files:**
- Create: `packages/secrets/{package.json,tsconfig.json,tsconfig.build.json,vitest.config.ts}`, `packages/secrets/src/{envelope,key-ring,index}.ts`
- Create: `apps/api/src/modules/identity/{password,totp,tokens,session.service,rate-limiter}.ts`
- Test: `packages/secrets/src/envelope.test.ts`, `apps/api/src/modules/identity/{password,totp,tokens}.test.ts`, `apps/api/src/modules/identity/{session.service,rate-limiter}.int.test.ts`

**Interfaces:**
- Produces (`@pcp/secrets`): `encryptSecret(plaintext: Buffer, aad: string, kek: { version: number; key: Buffer }): EncryptedSecret`; `decryptSecret(secret: EncryptedSecret, aad: string, keyRing: Map<number, Buffer>): Buffer`; `serializeSecret(s): string` / `deserializeSecret(s: string): EncryptedSecret` (base64 JSON); `loadKeyRing(env): { active: { version: number; key: Buffer }; ring: Map<number, Buffer> }` from `MASTER_KEY` (+ optional `MASTER_KEY_V<n>`, `MASTER_KEY_VERSION`).
- Produces (identity): `hashPassword(p: string): Promise<string>`, `verifyPassword(hash: string, p: string): Promise<boolean>`; `generateTotpSecret(): string` (base32, 20 bytes), `totp(secretBase32: string, unixSeconds: number, digits = 6): string`, `verifyTotp(secret, code, unixSeconds, window = 1): boolean`, `otpauthUri(secret, accountName, issuer = 'Product Control Plane')`; `randomToken(): string` (32 bytes base64url), `hashToken(t: string): string` (SHA-256 hex); `SessionService` `create(userId, opts: { mfaVerified: boolean }) → { token, session }`, `resolve(token) → Session | null` (idle 12 h, absolute 7 d; refreshes `last_seen_at`), `markMfaVerified(sessionId)`, `revoke(token)`, `revokeAllForUser(userId)`; `RateLimiter` `hit(key: string, limit = 10, windowSeconds = 60): Promise<{ allowed: boolean; retryAfterSeconds: number }>` (Redis fixed window).

- [x] **Step 1: Failing tests** — envelope: round trip; tampered ciphertext/tag/AAD throws; v1 secret decrypts after active key becomes v2. TOTP: RFC 6238 SHA-1 vectors (`12345678901234567890`, T=59 → `94287082`, T=1111111109 → `07081804`, T=1234567890 → `89005924`, 8 digits); `verifyTotp` accepts ±1 step, rejects ±2. Password: verify true/false; hash starts with `$argon2id$v=19$m=19456,t=2,p=1$`. Tokens: 43-char base64url, hash 64 hex. Sessions: idle expiry after 12 h, absolute after 7 d (injected clock), revokeAll. Rate limiter: 10 allowed, 11th denied with `retryAfterSeconds > 0`, separate keys independent.
- [x] **Step 2: Run** → FAIL.
- [x] **Step 3: Implement.**
- [x] **Step 4: Run** → PASS.
- [x] **Step 5: Handoff + commit** — `docs/handoffs/M2.3-identity-primitives.md`; `git commit -m "feat(identity): add secrets, passwords, TOTP, sessions, rate limiter (M2.3, M4.1)"`.

### Task 4: Authentication API (master M2.3 part 2)

**Files:**
- Create: `apps/api/src/modules/identity/{identity.module,auth.controller,auth.service,mfa.service,google-login.service,current-user.guard}.ts`, `apps/api/src/modules/mail/{mail.module,mailer}.ts`, `apps/api/src/database/{database.module,prisma.service}.ts`, `apps/api/src/redis/redis.module.ts`, `apps/api/src/common/{cookies,origin.guard}.ts`
- Modify: `apps/api/src/{app.module,config,main}.ts`
- Test: `apps/api/test/{global-setup,app-factory}.ts`, `apps/api/src/modules/identity/auth.int.test.ts`, `apps/api/src/modules/identity/google-login.int.test.ts`

**Interfaces:**
- Routes (WB-01 §7): `POST /api/v1/auth/signup` (202 always), `POST /api/v1/auth/verify`, `POST /api/v1/auth/login`, `POST /api/v1/auth/logout`, `POST /api/v1/auth/mfa/enroll`, `POST /api/v1/auth/mfa/verify`, `POST /api/v1/auth/password/reset-request` (202 always), `POST /api/v1/auth/password/reset`, `GET /api/v1/auth/google/start`, `GET /api/v1/auth/google/callback`, `GET /api/v1/me`.
- Produces: `CurrentUserGuard` attaching `request.user = { id, email, mfaEnrolled, sessionId, mfaVerified }`; error body `{ code: string; message: string; requestId }`; error codes `invalid_credentials`, `email_not_verified`, `mfa_required`, `rate_limited`, `invalid_token`, `google_login_not_configured`, `google_email_unverified`, `invalid_state`.
- Config additions: `APP_ORIGIN`, `MASTER_KEY`, `SMTP_URL` (optional; dev JSON transport logs), `MAIL_FROM`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` (all optional together), `BOOTSTRAP_MODE`.
- Cookie `pcp_session`: `HttpOnly; SameSite=Lax; Path=/`, `Secure` unless `BOOTSTRAP_MODE=private_http`, `Max-Age` 7 days.

- [x] **Step 1: Failing tests** (`auth.int.test.ts`, Testcontainers PG + Redis, in-memory mailer): sign-up of new and existing email both return 202 with identical bodies; verification token activates; unverified login → 403 `email_not_verified`; wrong password and unknown email → identical 401 `invalid_credentials`; 11 logins/min from one IP → 429 `rate_limited`; cookie flags with `BOOTSTRAP_MODE=off` include `Secure`, with `private_http` omit it; reset-request identical for unknown email; reset revokes existing sessions; MFA enroll → verify activates and returns 10 recovery codes once; login of MFA user yields session with `mfaVerified=false` until `mfa/verify`; recovery code works once; mutating request with foreign `Origin` → 403. `google-login.int.test.ts`: authorize URL `scope` is exactly `openid email profile` with PKCE `S256` and `state`; wrong `state` → 400 `invalid_state`; ID token with `email_verified=false` → 403 `google_email_unverified`; valid token (local JWKS, injected token endpoint) creates verified user and session; unconfigured Google → 404 `google_login_not_configured`.
- [x] **Step 2: Run** → FAIL.
- [x] **Step 3: Implement.**
- [x] **Step 4: Run** → PASS.
- [x] **Step 5: Handoff + commit** — `docs/handoffs/M2.3-authentication-api.md`; `git commit -m "feat(identity): add authentication API (M2.3)"`.

### Task 5: Organizations, products, environments, RBAC guard, tenant matrix (master M2.4)

**Files:**
- Create: `apps/api/src/common/{tenant.guard,require-permission.decorator,tenant-scope.decorator,errors}.ts`, `apps/api/src/modules/tenants/{tenants.module,organizations.controller,organizations.service}.ts`, `apps/api/src/modules/products/{products.module,products.controller,products.service}.ts`
- Test: `apps/api/src/modules/tenants/organizations.int.test.ts`, `apps/api/test/security/tenant-matrix.int.test.ts`

**Interfaces:**
- Decorators: `@RequirePermission(p: Permission)`, `@TenantScope({ param: 'orgId' | 'productId' | 'environmentId' })`, `@Public()` (no session), `@SessionOnly()` (session, no tenant).
- `TenantGuard` resolves the organization (route `orgId`, or `pcp_resolve_product_org` / `pcp_resolve_environment_org`), loads the membership, builds `TenantContext` on `request.tenant`, enforces MFA for owner/admin (403 `mfa_required`), checks `can()`; denial or non-membership → 404.
- Routes: `POST /api/v1/organizations` (verified email; creator becomes owner), `GET /api/v1/organizations/:orgId`, `PATCH /api/v1/organizations/:orgId/settings`, `POST /api/v1/organizations/:orgId/products`, `GET /api/v1/products/:productId`, `POST /api/v1/products/:productId/environments`, `GET /api/v1/products/:productId/overview`.

- [x] **Step 1: Failing tests** — `organizations.int.test.ts`: create org → owner membership; owner without MFA → 403 `mfa_required` on org routes; after MFA, create product with domains/repos and environments `Production`, `Staging`; duplicate environment name → 409; analyst scoped to product B gets 404 on FireMaps. `tenant-matrix.int.test.ts` (Review Focus #5 for this milestone): collects every registered route; every non-`@Public`/`@SessionOnly` route has `@RequirePermission` (fails naming any that lack it); a tenant-B owner (MFA verified) calling every route with tenant-A IDs receives 404.
- [x] **Step 2: Run** → FAIL.
- [x] **Step 3: Implement.**
- [x] **Step 4: Run** → PASS.
- [x] **Step 5: Handoff + commit** — `docs/handoffs/M2.4-organizations-rbac.md`; `git commit -m "feat(tenants): add organizations, products, environments, RBAC guard (M2.4)"`.

### Task 6: Audit log (master M2.5)

**Files:**
- Create: `apps/api/src/modules/auditing/{auditing.module,audit.service,audit.controller}.ts`
- Modify: organization/product services (record events in the same transaction)
- Test: `apps/api/src/modules/auditing/audit.int.test.ts`

**Interfaces:**
- `AuditService.record(tx: Prisma.TransactionClient, ctx: TenantContext, event: { action: string; targetType: string; targetId?: string; metadata?: Record<string, unknown> }): Promise<void>`.
- Route: `GET /api/v1/organizations/:orgId/audit-logs?limit=&before=` (`audit.view`), newest first, max 100 per page.
- Actions: `organization.created`, `member.owner_created`, `organization.settings_updated`, `product.created`, `environment.created`, `invitation.created`, `member.joined`, `member.updated`, `member.removed`.

- [x] **Step 1: Failing tests** — creating an organization writes `organization.created` and `member.owner_created`; product and environment creation audited with actor and target; `UPDATE audit_logs` and `DELETE FROM audit_logs` as `pcp_app` fail with `permission denied`; viewer → 404 on audit route; tenant B never sees tenant A audit rows.
- [x] **Step 2: Run** → FAIL.
- [x] **Step 3: Implement.**
- [x] **Step 4: Run** → PASS.
- [x] **Step 5: Handoff + commit** — `docs/handoffs/M2.5-audit-log.md`; `git commit -m "feat(auditing): add append-only audit log (M2.5)"`.

### Task 7: Members and invitations (master M2.6)

**Files:**
- Create: `apps/api/src/modules/members/{members.module,members.controller,members.service,invitations.service}.ts`
- Test: `apps/api/src/modules/members/members.int.test.ts`

**Interfaces:**
- Routes: `POST /api/v1/organizations/:orgId/invitations` (`org.members.manage`; returns `{ id, expiresAt }`, emails link with token), `POST /api/v1/invitations/accept` (`@SessionOnly`; body `{ token }`), `GET /api/v1/organizations/:orgId/members` (`org.view`), `PATCH /api/v1/organizations/:orgId/members/:memberId` (`org.members.manage`; `{ role?, productIds? }`), `DELETE /api/v1/organizations/:orgId/members/:memberId` (`org.members.manage`).
- Role rank: owner 5 > admin 4 > operator 3 > analyst 2 > viewer 1. An actor cannot grant, change, or remove above their own rank.

- [x] **Step 1: Failing tests** — operator inviting admin → 404 (operator lacks `org.members.manage`); admin inviting owner → 403 `role_above_inviter`; token stored hashed; accept by matching email creates membership with role and product scope; second accept → 400 `invalid_token`; expired (8 days, injected clock) → 400 `invalid_token`; signed-in email mismatch → 403 `email_mismatch`; removing or demoting the last owner → 409 `last_owner` (Review Focus #3); removed member's next request → 404.
- [x] **Step 2: Run** → FAIL.
- [x] **Step 3: Implement.**
- [x] **Step 4: Run** → PASS.
- [x] **Step 5: Handoff + commit** — `docs/handoffs/M2.6-members-invitations.md`; `git commit -m "feat(members): add members and invitations (M2.6)"`.

### Task 8: Compose migrate service, smoke, CI integration, docs

**Files:**
- Modify: `compose.yaml` (`migrate` one-shot; postgres superuser `postgres`; api uses `pcp_app`), `.env.example`, `apps/api/Dockerfile` (Prisma engines for musl), `tests/smoke/compose.smoke.test.ts`, `.github/workflows/ci.yml` (Docker available for integration tests — already on `ubuntu-24.04`), `docs/architecture/openapi-v1.yaml` (request schemas for implemented routes), `docs/workbooks/WB-01-accounts-organizations-access.md` checklist, `docs/handoffs/README.md`
- Create: `packages/database/Dockerfile` (migrate image)

**Interfaces:**
- Compose `migrate` service runs `pcp-db migrate` once (superuser bootstrap + `prisma migrate deploy`); `api` and `worker` depend on `migrate` `service_completed_successfully`.
- New env: `POSTGRES_SUPERUSER_PASSWORD`, `PCP_MIGRATOR_PASSWORD`, `PCP_APP_PASSWORD`, `PCP_SCHEDULER_PASSWORD`, `MASTER_KEY`, `APP_ORIGIN`.

- [x] **Step 1: Failing test** — smoke: after `up --wait`, `POST /api/v1/auth/signup` through Caddy returns 202, and `migrate` exited 0; config test asserts `PCP_APP_PASSWORD` and `MASTER_KEY` are required.
- [x] **Step 2: Run** → FAIL.
- [x] **Step 3: Implement.**
- [x] **Step 4: Run** → PASS (both modes); full `pnpm turbo run build lint typecheck test` green.
- [x] **Step 5: Handoff + commit** — `docs/handoffs/M2-compose-migrate.md`, board and workbook updates; `git commit -m "build: add migrate service and M2 smoke (M2)"`.
