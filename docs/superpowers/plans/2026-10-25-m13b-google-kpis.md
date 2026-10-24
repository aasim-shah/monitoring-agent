# M13b Google Sources and KPIs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect a customer's Google account through OAuth (GA4, Search Console, Firebase, Play vitals), store daily KPIs with honest freshness, and light up "Analytics & Ads" and "Mobile Apps & SDKs" plus the AI tool and the report section that depend on them.

**Architecture:**
- **Connector:** one `google` connector holds an encrypted refresh token and refreshes access tokens per run. Discovery lists properties, sites, Firebase projects and apps, and Play apps.
- **Sync:** a new hourly `connection-sync` job writes daily values into `metric_aggregates`, with completeness and status per day. A failed window writes nothing, never zero.
- **KPI catalog:** definitions are code (unit, window, source, caveats, comparability); the database holds values only.

**Tech Stack:** NestJS + Fastify, Prisma 6 with RLS, BullMQ, Next.js 15, Vitest, Playwright. Google OAuth 2.0 with PKCE; GA4 Admin and Data APIs, Search Console API, Firebase Management API, Play Developer Reporting API.

**Spec:** `AI_Product_Control_Plane_Architecture_and_Flows.md` §7.2, §7.5, §11.1–11.3, §19.1; master plan M13.1–M13.3, M13.6, M13.7; WB-08; WB-09 §UC-09-05/06.

## Global Constraints

- **Scopes:** prefix `https://www.googleapis.com/auth/`. The full read set is `analytics.readonly`, `analytics.manage.users.readonly`, `adwords`, `firebase.readonly`, `cloud-platform.read-only`, `monitoring.read`, `logging.read`, `bigquery.readonly`, `playdeveloperreporting`, `webmasters.readonly`, and `tagmanager.readonly` (WB-08 UC-08-01), plus `openid email` to show "Connected as".
- **Authorization request:** `access_type=offline`, `prompt=consent`, `include_granted_scopes=true`, PKCE S256. The state lives 10 minutes, is bound to the session user and the connection, and is used once.
- **Redirect URI:** `GOOGLE_CONNECTIONS_REDIRECT_URI`, which must differ from the login redirect (BR-08-01).
- **No zero for missing data:** a failed or unauthorized window writes no row. Quota exhaustion marks the source stale and backs off (BR-08-06).
- **Partial days:** GA4's current day is `partial`. Search Console's last 3 days are `partial` (Google's reporting delay).
- **GA4 `login` events** are never reported as authentication counts (BR-08-05).
- **No mutations:** the Ads `adwords` scope can write, so Ads stays off until a developer token exists and shows "pending platform approval" (M13.4 gated). No Google write method is ever called.
- **Test-only base URLs:** `PCP_GOOGLE_OAUTH_URL` and `PCP_GOOGLE_API_URL` work only with `PCP_ALLOW_TEST_PROVIDERS=1` (M7 rule).

## Review Focus

1. **Partial consent:** with `adwords` and `bigquery.readonly` unticked, those services are `permission_denied` and the others work. "Grant access" requests only the missing scopes, with `include_granted_scopes=true`.
2. **`invalid_grant` mid-sync:** the connection becomes `reauthorization_required`, sync stops, history stays, the creator is told once, and no row is written for the failed window.
3. **Wrong or replayed `state`:** a state from another session, another connection, or already used is refused, and no token is stored.
4. **Incomparable KPIs:** GA4 users and Play distinct users cannot be summed, enforced both at the type level and at runtime.
5. **GA4 quota error (429 / `RESOURCE_EXHAUSTED`):** existing values stay and are marked stale, and the next sync backs off; it never writes 0.

---

### Task 1: Data model and sync job

**Files:**
- `packages/database/prisma/migrations/0013_google_kpis/migration.sql`
- schema: `Connection.grantedScopes String[]` and `Connection.accountEmail String?`; model `MetricAggregate`
- `packages/jobs/src/queues.ts` (`connection-sync`) and `processors.ts`
- tests

- **`metric_aggregates` table:**
  - Columns: `organization_id`, `connection_id`, `product_id?`, `resource_type`, `external_id`, `metric`, `dimension` (text, `''` when none), `day` (date), `value double precision NULL`, `completeness` (`complete|partial`), `fetched_at`.
  - Unique `(connection_id, resource_type, external_id, metric, dimension, day)`. RLS like `change_events`.
  - Add it to `TENANT_TABLES` and the RLS seed.
- **`connection-sync` processor:**
  - Calls `runtime.sync(ctx, id)` and upserts the returned points.
  - Records a `sync` SyncRun.
  - Writes no point whose value is null.
- **Tests:** an RLS isolation case for the new table; the processor upserts and replaces a day's value, and nothing is written when sync throws.

### Task 2: Google OAuth framework (API)

**Files:** `apps/api/src/modules/google/{google-oauth.service.ts,google-oauth.controller.ts,google.module.ts,google-oauth.int.test.ts}` and `packages/connectors/google/src/scopes.ts`.

- **`POST /api/v1/connections/:id/oauth/google/start`** (`connection.configure`):
  - Body `{ missingOnly?: boolean }`. Returns `{ url }`.
  - Stores the state in Redis (`oauth:gconn:<state>`) with the user, connection, PKCE verifier, and requested scopes.
- **`GET /api/v1/connections/oauth/google/callback`** (session required):
  - Checks the state: same user, used once, 10-minute life.
  - Exchanges the code and stores `{ refreshToken }` with `storeCredentials`. On a re-grant without a new refresh token, it keeps the stored one.
  - Saves `grantedScopes` (from the token response's `scope`) and `accountEmail` (from the id token).
  - Moves the connection to `pending_validation`, queues validation, and redirects to `/orgs/:org/products/:product/integrations/:id` (product from the state).
- **Tests:**
  - TC-08-01: the URL holds the 11 scopes plus `openid email`, with offline access, consent, and S256.
  - TC-08-02: a wrong state, another user's state, and a reused state are refused, and nothing is stored.
  - TC-08-04: `missingOnly` requests only the scopes not yet granted, with `include_granted_scopes=true`.
  - Partial consent: `grantedScopes` stores exactly what Google returned.

### Task 3: Google connector

**Files:** `packages/connectors/google/src/{index.ts,token.ts,services.ts,ga4.ts,search-console.ts,firebase.ts,play.ts}` and `index.test.ts`.

- **Factory:** `createGoogleConnector({ clientId, clientSecret, oauthUrl?, apiUrl?, fetch?, destination?, now? })`.
- **Credentials:** `refreshToken`. The access token is refreshed per execution. `invalid_grant` raises `reauthorization_required`.
- **`services(grantedScopes)`:** for each service (ga4, searchConsole, firebase, play, ads, bigquery), returns `available`, `permission_denied`, or `pending_platform_approval` (ads).
- **Validate:** refreshes the token, then probes the services whose scope was granted. It succeeds when at least one data service answers; services that answer 403 are reported as missing permissions.
- **Discover:**
  - `google_ga4_property` (displayName, timeZone, currencyCode, streams with URLs and package names)
  - `google_search_console_site` (permissionLevel)
  - `google_firebase_project`, and `google_firebase_app` (platform, packageName or bundleId)
  - `google_play_app` (packageName)
- **`sync(ctx, { scopes, days })`:** returns `MetricPoint[]` for the scoped resources over the last `days` (28 on first sync, then 3):
  - **GA4 `runReport`** by `date`: `activeUsers`, `newUsers`, `sessions`, `screenPageViews`, `engagementRate`, `keyEvents`, with `returnPropertyQuota`. Also by `sessionDefaultChannelGroup` (dimension).
  - **Search Console** by `date`: `clicks`, `impressions`, `ctr`, `position`.
  - **Play** `crashRateMetricSet` and `anrRateMetricSet` daily: `userPerceivedCrashRate`, `crashRate`, `userPerceivedAnrRate`, `anrRate`, `distinctUsers`.
- **Errors:** a 429 or `RESOURCE_EXHAUSTED` raises `rate_limited` with `retryAfterSeconds`, and the processor keeps existing rows. A per-service 403 skips that service and records the gap.
- **Tests:** contract fixtures for each API; partial consent; `invalid_grant`; quota; today `partial`; a static test that no source file contains `mutate` or a GA4 `login` mapping.

### Task 4: KPI catalog and API

**Files:**
- `packages/shared-contracts/src/kpis.ts`: `KPI_DEFINITIONS`, `KpiKind`, `sumKpis`
- `apps/api/src/modules/kpis/*`: `GET /api/v1/products/:productId/kpis?range=7d|28d|90d`, permission `telemetry.query`

- **Each definition:** key, label, unit, aggregation (`sum|mean|last`), window (`day`), source, caveats, and a `population` brand. `sumKpis` refuses mixed populations at compile time (branded types) and at runtime (throws `incomparable_kpis`).
- **Response:** a series per resource and metric, with points `[day, value|null, completeness]`, totals, and a freshness block (`lastSuccessfulSync`, `lastAttempt`, `expectedInterval`, `status`, `reason`). Services that are missing are listed as gaps.
- **Tests:**
  - only product-scoped resources are returned
  - a missing day is null
  - a provider failure gives `status: stale` with the reason
  - `sumKpis` throws for GA4 users plus Play users

### Task 5: AI tool and report section

- **`getAnalyticsReport`** becomes real: KPI totals and the top channels for the range. With no Google connection the gap is "Analytics: source not connected".
- **Report section `analytics` (S5):** the day's GA4 and Search Console values. It is missing only when no Google connection exists.
- **Mobile values:** Play vitals go into the same section under "Mobile".
- **Tests:** an AI tool test and a reports snapshot test.

### Task 6: Web

- **Integrations:**
  - a Google card with a scope list (one line per scope) and "Connect with Google", which creates the connection and starts OAuth
  - on the connection page: "Connected as …", a service grid (available, permission denied, pending platform approval) with a "Grant access" button
- **Analytics & Ads page:** KPI tiles and daily charts per property and site, a freshness line, "Partial" on today, an Ads card "pending platform approval", and gaps.
- **Mobile Apps & SDKs page:** Firebase apps and Play vitals per app. The SDK card says "SDK not available yet".
- **Nav:** both entries enabled (`telemetry.query`).
- **Tests:** the web tests for the grid and grant flow, a KPI tile showing "No data" (not 0), and nav.

### Task 7: Exit gate, deploy, docs

1. **Playwright `google.spec.ts`:**
   - a fake Google (OAuth token endpoint and APIs) in the e2e stack, reached through the test overrides
   - the start redirect URL is checked
   - the test follows the callback with the state from that URL
   - the partial grant shows Ads as pending and BigQuery as permission denied
   - discovery, then scope a GA4 property; sync fills the Analytics page
2. **Full pipeline.** Deploy migration 0013, api, web, and worker.
3. **Production check:** the start URL is correct for the real client; the callback refuses a bad state.
4. **Docs:** the runbook lists the Google Cloud APIs to enable and the consent screen steps.
5. **Close out:** docs, push, memory.
