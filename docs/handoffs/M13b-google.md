# Handoff — M13b Google sources and KPIs

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-25 |
| **Branch** | `feat/m13b-google` |
| **Plan** | `docs/superpowers/plans/2026-10-25-m13b-google-kpis.md` |
| **Workbooks** | WB-08 (Google integrations), WB-09 (KPIs and freshness) |

## Delivered

- **Connect Google:** one read-only OAuth grant.
  - PKCE S256; offline access; consent; incremental grants.
  - The state is single-use, lives 10 minutes, and is bound to the member and the connection.
  - The connection page shows "Connected as …", a per-service grid, and "Grant access" for scopes left unticked.
- **Google connector** (`packages/connectors/google`):
  - Refreshes the access token per run. `invalid_grant` becomes `reauthorization_required`.
  - Calls only the services that were granted. A service that is denied becomes a named gap.
  - **Discovery:** GA4 properties with their streams, Search Console sites, Firebase projects and apps, and Play apps.
  - **Daily values:**
    - GA4: active and new users, sessions, views, engagement rate, key events, and sessions by channel. Today is partial.
    - Search Console: clicks, impressions, CTR, and position. The last 3 days are partial.
    - Play vitals: crash and ANR rates (all and user-perceived), and daily users.
- **KPI storage:**
  - `metric_aggregates` (migration 0013) holds the daily values. `connections.granted_scopes` and `account_email` record the grant.
  - The `connection-sync` job runs hourly and also right after a scope is saved. The first sync reads 28 days back; later syncs read 3.
- **KPI catalog** (`packages/shared-contracts/src/kpis.ts`):
  - Each KPI records its definition, unit, window, source, timezone, and caveats.
  - Unique-user counts are averaged over a range, never summed.
  - Counts from different populations cannot be added, enforced both at compile time and at runtime.
- **`GET /api/v1/products/:id/kpis?range=7d|28d|90d`:**
  - Returns every day of the range; a day with no value is null, never 0.
  - Also returns totals, GA4 sessions by channel, and freshness per source (current, stale, or unavailable, with the reason).
  - Lists missing or waiting services as gaps.
- **Pages:**
  - **Analytics & Ads:** GA4 and Search Console tiles and charts; Ads shows "pending platform approval".
  - **Mobile Apps & SDKs:** Play vitals, the scoped Firebase apps, and "SDK not available yet".
  - No sidebar entry says "Soon" anymore.
- **Elsewhere:**
  - The AI tool `getAnalyticsReport` answers from these values.
  - The daily report's analytics section lists the report day's values.
  - A revoked grant emails the member who connected and the owners, once.

## Google Cloud setup (needed before real data flows)

Do these in the Google Cloud project that owns the OAuth client (`GOOGLE_CLIENT_ID`):

1. **APIs & Services → Library.** Enable:
   - Google Analytics Admin API
   - Google Analytics Data API
   - Google Search Console API
   - Firebase Management API
   - Google Play Developer Reporting API

   A disabled API shows as a gap on the Analytics page with Google's message ("… API has not been used in project … or it is disabled").
2. **Credentials → the OAuth client → Authorized redirect URIs.** Add `https://monitor.aasimshah.com/api/v1/connections/oauth/google/callback` (the value of `GOOGLE_CONNECTIONS_REDIRECT_URI`).
3. **OAuth consent screen.**
   - In **Testing**: add every Google account that connects as a test user. Refresh tokens then expire after 7 days and the connection asks to reconnect.
   - In **Production** without verification: Google shows an "unverified app" warning that the member can click through. Google verification (privacy policy, demo video, scope justification) removes it.
4. **Play vitals.** The Google account that connects needs access to the app in Play Console → Users and permissions.
5. **Google Ads.** Needs a Google Ads developer token, which is a separate Google review (M13.4). Until then Ads shows "pending platform approval".

## Verify

```bash
pnpm --filter @pcp/connectors-google test
pnpm --filter @pcp/api exec vitest run src/modules/connections src/modules/kpis src/modules/ai
pnpm --filter @pcp/tests test:e2e google.spec.ts
```

## Limitations

- BigQuery exports (Crashlytics crash-free users, Performance, raw GA4 events), Cloud Monitoring and Logging, and Tag Manager are requested but not read yet. They show as "not read yet".
- The Ads connector waits for a developer token.
- There is no in-app SDK yet.
