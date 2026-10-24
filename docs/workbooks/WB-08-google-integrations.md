# WB-08 · Google Integrations

| | |
|---|---|
| **Milestones** | M13.1–M13.4 |
| **Spec** | §7.2 (all subsections), §19.1 |
| **Plan decisions** | §3 OAuth state; Review Focus #4 |
| **Owners** | Backend |

## 1. Purpose and scope

Connecting a customer's Google data — GA4, Google Ads, Firebase, Cloud Monitoring/Logging, BigQuery exports (Crashlytics, Performance Monitoring, GA4 raw events), Play vitals, Search Console, Tag Manager — through one OAuth connection with the full read scope set. Google *login* is WB-01.

## 2. Actors

Admin (connects with their Google account), worker (syncs), Google OAuth and APIs, enterprise security team (keyless mode).

## 3. Use cases

| ID | Use case | Outcome |
|---|---|---|
| UC-08-01 | Connect Google with the full read scope set | Refresh token encrypted; granted scopes recorded |
| UC-08-02 | Partial consent → grant missing access | Missing services show `permission_denied`; incremental re-auth adds them |
| UC-08-03 | Assign Google resources to products/environments | GA4 properties, Ads accounts, Firebase projects, Play apps, Search Console sites scoped |
| UC-08-04 | Sync GA4 reports | Users, sessions, events, traffic sources, engagement, key events, geo |
| UC-08-05 | Collect Firebase and Cloud Monitoring metrics | Project/app metadata and supported metrics |
| UC-08-06 | Read Crashlytics/Performance/GA4 exports from BigQuery | Crash and performance KPIs when exports are enabled |
| UC-08-07 | Collect Play Android vitals | Crash rate, ANR rate per version |
| UC-08-08 | Collect Search Console analytics | Queries, clicks, impressions, indexing coverage |
| UC-08-09 | Collect Google Ads performance (gated) | Campaigns, spend, clicks, impressions, conversions |
| UC-08-10 | Handle revoked token (`invalid_grant`) | `reauthorization_required`; sync stops; history kept |
| UC-08-11 | Keyless service-account mode | Platform service account granted access by customer; no key file |
| UC-08-12 | Firebase Auth counts through the private worker | Authentication counts from Admin SDK with customer credentials |

## 4. Flows

### UC-08-01: OAuth connection (spec §7.2.1)

```mermaid
sequenceDiagram
  participant U as Admin
  participant UI as Dashboard
  participant API as Control API
  participant G as Google OAuth
  participant W as Worker
  U->>UI: Connect Google (product/environment)
  UI->>API: POST /api/v1/connections/:id/authorize
  API->>API: state (10 min, bound to session) + PKCE verifier
  API-->>UI: Redirect: scopes, access_type=offline, prompt=consent, include_granted_scopes=true
  UI->>G: Consent screen
  G-->>API: GET /api/v1/oauth/google/callback?code&state
  API->>API: Validate state; exchange code with verifier
  API->>API: Encrypt refresh token; store granted scopes
  API->>W: Queue validation + discovery
  W->>G: List properties, accounts, projects, apps, sites
  W-->>UI: Selectable resources + missing scopes
```

Scope set (prefix `https://www.googleapis.com/auth/`): `analytics.readonly`, `analytics.manage.users.readonly`, `adwords`, `firebase.readonly`, `cloud-platform.read-only`, `monitoring.read`, `logging.read`, `bigquery.readonly`, `playdeveloperreporting`, `webmasters.readonly`, `tagmanager.readonly`.

The Connect screen explains each scope in one line and shows "Connected as <google email>".

### UC-08-02: Partial consent

1. Token response `scope` lacks, for example, `adwords` and `bigquery.readonly`.
2. `connection_granted_scopes` stores the granted list.
3. Ads and BigQuery-backed services show `permission_denied` with "Grant access" buttons.
4. Clicking a button starts a new authorization requesting only the missing scopes with `include_granted_scopes=true`.

### UC-08-04: GA4 sync

1. Admin API: account summaries → properties → data streams (stream URLs feed WB-10 app-to-analytics correlation).
2. Data API `runReport` hourly or less often, with `returnPropertyQuota`.
3. Today's data is always `completeness: 'partial'` (GA4 processing delay).
4. Historical comparisons use the same definition and timezone (property timezone recorded as KPI caveat).

### UC-08-06: BigQuery exports

1. Discovery checks for export datasets (Crashlytics, Performance Monitoring, GA4 `events_*`).
2. Missing dataset → coverage gap "Crashlytics export not enabled" with instructions; not an error.
3. Present → named query templates (crash-free users, top issues, app start time) with date partition filters only.

### UC-08-09: Google Ads (gated)

Enabled only after the platform's developer token is approved. GAQL through a wrapper exposing only `search`/`searchStream`; `login-customer-id` set for manager accounts. Never mutates.

### UC-08-10: Revoked token

1. Refresh fails with `invalid_grant` (user revoked access, password change policy, or token expiry in Testing mode).
2. Connection → `degraded` + `reauthorization_required`; sync stops; historical data stays.
3. Owner notified once; banner on affected dashboards: "Google connection needs reauthorization".
4. No metric value is written for the failed windows.

### UC-08-11: Keyless service-account mode

1. Platform creates a per-tenant service account in the vendor project.
2. Customer grants that email Viewer on GA4 properties / read roles on projects.
3. Platform calls Google as that service account; ownership of each resource ID is verified per call.

### UC-08-12: Firebase Auth counts

Optional private-worker task using the Firebase Admin SDK with customer credentials stored locally; returns counts only (no user records).

## 5. Business rules

| ID | Rule |
|---|---|
| BR-08-01 | Login scopes are never mixed with data scopes. |
| BR-08-02 | No service-account JSON key is created or downloaded for customers. |
| BR-08-03 | Granted scopes are recorded and drive per-service status. |
| BR-08-04 | `adwords` permits writes; the connector never issues mutate operations. |
| BR-08-05 | GA4 `login` events are never reported as authentication counts. |
| BR-08-06 | Today's GA4 data is partial; quota exhaustion marks data stale, never zero. |
| BR-08-07 | One Google connection is tied to the person who granted it; UI shows that identity and recommends a shared operations account. |
| BR-08-08 | Shared service accounts are not used across tenants (confused-deputy prevention). |

## 6. Data

`connections`, `connection_secrets` (refresh token), `connection_granted_scopes`, `connection_resource_scopes`, `metric_definitions`, `metric_aggregates`, `business_events`.

## 7. Screens

Integrations → Google (scope explanations, consent, "Connected as", per-service status grid with grant buttons), resource assignment, Analytics & Ads dashboards, Mobile (Play vitals, Crashlytics), Websites (Search Console).

## 8. Edge cases

| Case | Expected behavior |
|---|---|
| The Google user who connected leaves the company | Token may be revoked → UC-08-10; banner suggests reconnecting with a shared account |
| Several Google accounts needed (agency + client) | Multiple Google connections per organization, each scoped |
| App in Google "Testing" mode | Refresh tokens expire after 7 days; staging banner explains |
| GA4 property timezone differs from org timezone | KPI caveat shows property timezone; reports convert explicitly |
| Ads developer token not approved | Ads service shows "pending platform approval" |
| BigQuery export present but costly query | Templates use partition filters; per-run bytes-billed cap |

## 9. Test cases

| ID | Covers | Given / When / Then |
|---|---|---|
| TC-08-01 | UC-08-01 | Authorize URL contains all 11 scopes, `access_type=offline`, `prompt=consent`, PKCE S256 |
| TC-08-02 | UC-08-01 | Callback with wrong `state` → rejected; no token stored |
| TC-08-03 | Review Focus #4 | Unticked `adwords` + `bigquery.readonly` → those services `permission_denied`, others connected |
| TC-08-04 | UC-08-02 | Grant button requests only missing scopes with `include_granted_scopes=true` |
| TC-08-05 | Review Focus #4 | `invalid_grant` mid-sync → `reauthorization_required`, sync stops, owner notified once, no 0 rows |
| TC-08-06 | BR-08-04 | Static test fails if any Ads mutate method is referenced |
| TC-08-07 | BR-08-06 | GA4 quota error → data stale + backoff |
| TC-08-08 | UC-08-06 | Missing Crashlytics dataset → coverage gap, not error |
| TC-08-09 | BR-08-05 | No code path maps GA4 `login` to authentication KPIs |

## 10. Task checklist

- [x] M13.1 Google OAuth framework
- [x] M13.2 GA4 connector
- [x] M13.3 Firebase, Play, Search Console, BigQuery exports (BigQuery exports: not read yet)
- [ ] M13.4 Google Ads connector (gated on developer token)

## 11. Acceptance criteria

1. Google connection completes through OAuth; GA4 data appears with granted-scope status visible (pilot item 12).
2. Review Focus #4 tests pass.
3. Google app verification is approved before pilot.

## 12. Open items

- Keyless service-account mode (UC-08-11) scheduling: proposed post-pilot unless a pilot customer requires it.
