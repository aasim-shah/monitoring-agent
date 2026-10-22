# M3 Dashboard Shell — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver master-plan M3: a typed API client generated from OpenAPI, and a Next.js dashboard where a person signs up, verifies email, signs in, enrolls MFA, creates an organization, creates the FireMaps product with Production and Staging environments, invites a member, and reads the audit log — proven by Playwright against the real Compose stack.

**Architecture:** `@pcp/api-client` generates `paths` types from `docs/architecture/openapi-v1.yaml` (openapi-typescript) and exposes an `openapi-fetch` client that calls same-origin `/api/v1/*` with cookies. The web app is Next.js 15 App Router with Tailwind CSS 4 and small shadcn-style primitives (Radix where needed). Pages fetch on the client with TanStack Query; Next middleware redirects requests without a session cookie to `/login`. The API stays the only authority: 401 → login, 403 `mfa_required` → `/mfa`, 404 → not-found state. The role matrix moves to `@pcp/shared-contracts` so the browser can hide what the API would refuse (UI hiding is never authorization).

**Tech Stack:** M2 stack plus openapi-typescript 7.13.0, openapi-fetch 0.14.1, Tailwind CSS 4.3.3 (`@tailwindcss/postcss`), TanStack Query 5.104.5, React Hook Form 7.90.0, `@hookform/resolvers` 5.9.2, Radix (`react-slot` 1.5.0, `react-label` 2.1.17, `react-dialog` 1.3.1, `react-dropdown-menu` 2.2.1), `class-variance-authority` 0.7.1, `clsx` 2.1.1, `tailwind-merge` 3.7.0, `lucide-react` 0.577.0, Testing Library (`react` 16.3.3, `jest-dom` 6.10.0, `user-event` 14.6.8), jsdom 26.1.0, `@vitejs/plugin-react` 4.7.0, Playwright 1.64.1, Mailpit (`axllent/mailpit`, e2e only).

**Spec:** spec §21 (dashboard IA), §6.1–6.2; master plan M3.1–M3.3; workbook WB-01 (UC-01-01 to UC-01-17, screens §8); handoffs M2.3–M2.6 (API contracts).

## Global Constraints

- All master-plan Global Constraints apply.
- UI hiding is not authorization; every page must behave correctly when the API returns 401, 403, or 404.
- Real states only: loading, empty, error, disconnected; no fake data, no placeholder metrics.
- Sections of spec §21 not yet built appear in navigation as disabled items labelled with the milestone that delivers them.
- No secrets in the browser: session cookie is HttpOnly; MFA secret and recovery codes are shown once and never stored client-side.
- `@pcp/api-client` generated types must match `openapi-v1.yaml` (drift check in tests).

## Review Focus

1. **Session expires mid-use.** Expected: next API call returns 401 and the UI redirects to `/login?next=<current path>`; after login the user returns there. Test in Task 4 (`handles 401 by redirecting to login`).
2. **Owner without MFA opens any organization page.** Expected: API 403 `mfa_required` → redirect to `/mfa`. Test in Task 6 (e2e onboarding).
3. **Viewer types a settings URL directly.** Expected: settings hidden in nav and the page shows the not-found state from the API's 404. Test in Task 6 (`navigation.spec.ts`).
4. **Double-submitted forms** (create organization twice). Expected: submit button disabled while pending. Test in Task 3.
5. **Open redirect through `next`.** Expected: only same-origin relative paths are honored. Test in Task 3 (`safeNext`).

---

### Task 1: Typed API client (master M3.3)

**Files:**
- Create: `packages/api-client/{package.json,tsconfig.json,tsconfig.build.json,vitest.config.ts}`, `packages/api-client/scripts/generate.mjs`, `packages/api-client/src/{schema.d.ts (generated),client.ts,errors.ts,index.ts}`
- Test: `packages/api-client/src/generate.test.ts`, `packages/api-client/src/errors.test.ts`

**Interfaces:**
- Produces: `type paths`, `type components` (generated); `createApiClient(opts?: { baseUrl?: string; fetch?: typeof fetch })` → `openapi-fetch` client with `credentials: 'include'`; `ApiError` class `{ status: number; code: string; message: string; requestId?: string }`; `unwrap<T>(result): T` throws `ApiError` on error responses; `type Schemas = components['schemas']`.

- [ ] **Step 1: Failing tests** — `generate.test.ts`: `node scripts/generate.mjs --check` exits 0. `errors.test.ts`: `unwrap` returns data on success; throws `ApiError` with `status`, `code`, `message`, `requestId` from an error body; falls back to `code: 'error'` for non-JSON bodies.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; `pnpm turbo run build typecheck --filter @pcp/api-client` → exit 0.
- [ ] **Step 5: Handoff + commit** — `docs/handoffs/M3.3-api-client.md`; `git commit -m "feat(api-client): add typed OpenAPI client (M3.3)"`.

### Task 2: Web foundation — styles, primitives, state components, providers, role matrix move (master M3.1 part 1)

**Files:**
- Modify: `packages/shared-contracts/src/{index.ts}`, create `packages/shared-contracts/src/role-matrix.ts` (moved `ROLE_PERMISSIONS`, `can`); `packages/tenant-security/src/{index,role-matrix,permissions}.ts` re-export from shared-contracts
- Create: `apps/web/{postcss.config.mjs}`, `apps/web/app/globals.css`, `apps/web/components/ui/{button,input,label,card,alert,badge,field}.tsx`, `apps/web/components/states/{loading,empty,error-state,disconnected,not-found-state}.tsx`, `apps/web/lib/{cn,api,query-client}.ts`, `apps/web/app/providers.tsx`
- Modify: `apps/web/app/layout.tsx`, `apps/web/vitest.config.ts` (React plugin; jsdom per file)
- Test: `apps/web/components/states/states.test.tsx`, `apps/web/lib/api.test.ts`

**Interfaces:**
- Produces (web): `cn(...classes)`; `api` = `createApiClient()`; `queryClient` defaults (retry false for 4xx; 30 s stale); `<Loading label>`, `<Empty title action?>`, `<ErrorState error onRetry>`, `<Disconnected>`, `<NotFoundState>`; `handleApiError(error, router, pathname)` → 401 → `/login?next=…`, 403 `mfa_required` → `/mfa`, else returns the error.
- Shared contracts: `ROLE_PERMISSIONS`, `can` now exported from `@pcp/shared-contracts`; `@pcp/tenant-security` re-exports them unchanged.

- [ ] **Step 1: Failing tests** — states render accessible text (`role="status"` for loading, `role="alert"` for errors, retry button calls `onRetry`); `handleApiError` maps 401 to `/login?next=%2Forgs%2Fx`, `mfa_required` to `/mfa`, and returns other errors; shared-contracts `can` test (owner can `org.members.manage`, viewer cannot); tenant-security tests unchanged and green.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; `next build` succeeds.
- [ ] **Step 5: Handoff + commit** — `docs/handoffs/M3.1-web-foundation.md`; `git commit -m "feat(web): add styles, primitives, states, providers (M3.1)"`.

### Task 3: Authentication pages (master M3.1 part 2)

**Files:**
- Create: `apps/web/app/(auth)/{layout.tsx,login/page.tsx,signup/page.tsx,verify/page.tsx,reset/page.tsx,mfa/page.tsx,invitations/accept/page.tsx}`, `apps/web/components/auth/*`, `apps/web/lib/safe-next.ts`, `apps/web/middleware.ts`
- Test: `apps/web/lib/safe-next.test.ts`, `apps/web/components/auth/login-form.test.tsx`, `apps/web/middleware.test.ts`

**Interfaces:**
- Routes: `/login`, `/signup`, `/verify?token=`, `/reset` (request) and `/reset?token=` (choose password), `/mfa` (enroll or verify; shows recovery codes once), `/invitations/accept?token=`.
- `safeNext(next: string | null): string` → relative same-origin path or `/orgs`.
- Middleware: paths outside `(auth)`, `/healthz`, `/_next`, static files → redirect to `/login?next=` when no `pcp_session` cookie.

- [ ] **Step 1: Failing tests** — `safeNext`: `/orgs/a` kept; `//evil.com`, `https://evil.com`, `/\\evil`, `javascript:` → `/orgs` (Review Focus #5). Login form: client validation errors; submit disabled while pending (Review Focus #4); API `invalid_credentials` shown as a message; `mfaRequired: true` navigates to `/mfa`. Middleware: no cookie on `/orgs` → 307 to `/login?next=%2Forgs`; `/login` passes; with cookie passes.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Handoff + commit** — `docs/handoffs/M3.1-auth-pages.md`; `git commit -m "feat(web): add authentication pages (M3.1)"`.

### Task 4: App shell — organizations, context switcher, navigation (master M3.1 part 3)

**Files:**
- Create: `apps/web/app/(app)/{layout.tsx,orgs/page.tsx}`, `apps/web/app/(app)/orgs/[orgId]/layout.tsx`, `apps/web/components/shell/{app-header,context-switcher,org-nav,product-nav}.tsx`, `apps/web/lib/{nav,use-me,use-api-query}.ts`
- Test: `apps/web/lib/nav.test.ts`, `apps/web/lib/use-api-query.test.tsx`

**Interfaces:**
- `buildProductNav(role: Role): NavItem[]` and `buildOrgNav(role: Role): NavItem[]` where `NavItem = { label; href?; milestone?: string; permission?: Permission }`; items without `href` are disabled with their milestone label. Product nav follows spec §21 order: Health Overview, Integrations (M7), Agents (M5), Assets (M9), Infrastructure (M6), Websites & APIs (M13), Mobile Apps & SDKs (M13), Databases (M8), Analytics & Ads (M13), Incidents & Alerts (M12), AI Assistant (M14), Reports & Schedules (M15), Automations & Approvals (M16), Audit Log. Org nav: Overview, Members & Roles (`org.members.manage` to manage, `org.view` to view), Audit Log (`audit.view`), Settings (`org.settings.manage`).
- `useApiQuery(key, fn)` wraps TanStack Query and applies `handleApiError`.
- `/orgs`: memberships from `/me`, create-organization form (name, timezone default from browser).

- [ ] **Step 1: Failing tests** — viewer org nav lacks Settings and Audit Log; owner has both; product nav lists all 14 §21 sections in order with unbuilt ones disabled and labelled; `useApiQuery` redirects on 401 to `/login?next=<path>` (Review Focus #1).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Handoff + commit** — `docs/handoffs/M3.1-app-shell.md`; `git commit -m "feat(web): add app shell, context switcher, navigation (M3.1)"`.

### Task 5: Organization, product, environment, members, audit, settings screens (master M3.2)

**Files:**
- Create: `apps/web/app/(app)/orgs/[orgId]/{page.tsx,members/page.tsx,audit/page.tsx,settings/page.tsx}`, `apps/web/app/(app)/orgs/[orgId]/products/[productId]/page.tsx`, `apps/web/components/{products,members,audit,settings}/*`
- Test: `apps/web/components/members/role-select.test.tsx`, `apps/web/components/audit/audit-table.test.tsx`

**Interfaces:**
- Organization overview: products list + create product (name, description, domains, repositories). Product page: environments list + add environment, product facts; environment switcher entries.
- Members: list, invite (email, role, optional product scope), change role, remove; roles above the viewer's own are not offered; API errors (`role_above_actor`, `last_owner`) shown inline.
- Audit: table newest first, "Load more" using `nextBefore`.
- Settings: name, timezone, data retention days.

- [ ] **Step 1: Failing tests** — role select offers only roles at or below the actor; audit table renders entries and calls `onLoadMore` when `nextBefore` exists, hides the button when null; empty state when no entries.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; `next build` succeeds.
- [ ] **Step 5: Handoff + commit** — `docs/handoffs/M3.2-screens.md`; `git commit -m "feat(web): add organization, product, members, audit, settings screens (M3.2)"`.

### Task 6: End-to-end tests against the Compose stack, CI, docs

**Files:**
- Create: `tests/e2e/compose.e2e.yaml` (adds `mailpit`, sets `SMTP_URL=smtp://mailpit:1025`, publishes Mailpit API on `127.0.0.1:${MAILPIT_PORT}`), `tests/e2e/playwright.config.ts`, `tests/e2e/global-setup.ts`, `tests/e2e/helpers/{mailpit,totp}.ts`, `tests/e2e/onboarding.spec.ts`, `tests/e2e/navigation.spec.ts`
- Modify: `tests/package.json` (`test:e2e`), `.github/workflows/ci.yml` (job `e2e`), `docs/workbooks/WB-01-accounts-organizations-access.md` (M3 checklist), `docs/handoffs/README.md`

**Interfaces:**
- `pnpm test:e2e` brings up the stack with the e2e override, installs Chromium, runs Playwright, and tears down.

- [ ] **Step 1: Failing tests** — `onboarding.spec.ts`: sign up → open verification link from Mailpit → sign in → create "Example Company" → redirected to `/mfa` (Review Focus #2) → enroll with TOTP → recovery codes shown → create FireMaps with domains → add Production and Staging → invite a member (email arrives in Mailpit) → audit log lists `organization.created`, `product.created`, `environment.created`, `invitation.created`. `navigation.spec.ts`: viewer (invited, accepted) sees no Settings or Audit Log in nav; typing `/orgs/<id>/settings` shows the not-found state (Review Focus #3).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** remaining glue (fix any defects the e2e tests reveal, test-first).
- [ ] **Step 4: Run** → PASS; full `pnpm turbo run build lint typecheck test` green.
- [ ] **Step 5: Handoff + commit** — `docs/handoffs/M3-e2e.md`; board and workbook updates; `git commit -m "test(e2e): add onboarding and navigation journeys (M3)"`.
