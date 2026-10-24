/**
 * Google data scopes (WB-08 UC-08-01, spec §7.2.2). Login scopes are never mixed in (BR-08-01);
 * `openid email` is requested only to show which account granted access (BR-08-07).
 */
export const SCOPE_PREFIX = 'https://www.googleapis.com/auth/';

export const GOOGLE_DATA_SCOPES = [
  'analytics.readonly',
  'analytics.manage.users.readonly',
  'adwords',
  'firebase.readonly',
  'cloud-platform.read-only',
  'monitoring.read',
  'logging.read',
  'bigquery.readonly',
  'playdeveloperreporting',
  'webmasters.readonly',
  'tagmanager.readonly',
].map((s) => `${SCOPE_PREFIX}${s}`);

export const GOOGLE_IDENTITY_SCOPES = ['openid', 'email'];

export type GoogleService = 'ga4' | 'searchConsole' | 'firebase' | 'play' | 'ads' | 'bigquery';

/** What each scope is for, one line each, for the connect screen. */
export const SCOPE_PURPOSE: Record<string, string> = {
  'analytics.readonly': 'GA4 reports: users, sessions, events, traffic sources',
  'analytics.manage.users.readonly': 'Who can see each GA4 property (read-only)',
  adwords: 'Google Ads performance (read only; the platform never changes campaigns)',
  'firebase.readonly': 'Firebase projects and apps',
  'cloud-platform.read-only': 'Google Cloud project metadata',
  'monitoring.read': 'Cloud Monitoring metrics',
  'logging.read': 'Cloud Logging entries',
  'bigquery.readonly': 'Crashlytics, Performance, and GA4 exports in BigQuery',
  playdeveloperreporting: 'Play Console Android vitals: crash and ANR rates',
  'webmasters.readonly': 'Search Console: clicks, impressions, positions',
  'tagmanager.readonly': 'Tag Manager containers',
};

export const SERVICE_LABEL: Record<GoogleService, string> = {
  ga4: 'GA4',
  searchConsole: 'Search Console',
  firebase: 'Firebase',
  play: 'Play vitals',
  ads: 'Google Ads',
  bigquery: 'BigQuery exports',
};

export const STATUS_TEXT: Record<ServiceStatus, string> = {
  available: 'available',
  permission_denied: 'access not granted',
  pending_platform_approval: 'pending platform approval',
  not_read_yet: 'not read yet',
};

/** The scope each service needs. */
export const SERVICE_SCOPE: Record<GoogleService, string> = {
  ga4: `${SCOPE_PREFIX}analytics.readonly`,
  searchConsole: `${SCOPE_PREFIX}webmasters.readonly`,
  firebase: `${SCOPE_PREFIX}firebase.readonly`,
  play: `${SCOPE_PREFIX}playdeveloperreporting`,
  ads: `${SCOPE_PREFIX}adwords`,
  bigquery: `${SCOPE_PREFIX}bigquery.readonly`,
};

export type ServiceStatus = 'available' | 'permission_denied' | 'pending_platform_approval' | 'not_read_yet';

/**
 * Per-service status from the granted scopes (BR-08-03). Ads waits for the platform's developer
 * token (M13.4); BigQuery exports are not read yet, so a granted scope is still "not read yet".
 */
export function serviceStatus(granted: readonly string[]): Record<GoogleService, ServiceStatus> {
  const has = (s: GoogleService) => granted.includes(SERVICE_SCOPE[s]);
  return {
    ga4: has('ga4') ? 'available' : 'permission_denied',
    searchConsole: has('searchConsole') ? 'available' : 'permission_denied',
    firebase: has('firebase') ? 'available' : 'permission_denied',
    play: has('play') ? 'available' : 'permission_denied',
    ads: has('ads') ? 'pending_platform_approval' : 'permission_denied',
    bigquery: has('bigquery') ? 'not_read_yet' : 'permission_denied',
  };
}

/** Scopes still missing from a grant: what "Grant access" asks for (WB-08 UC-08-02). */
export const missingScopes = (granted: readonly string[]) =>
  GOOGLE_DATA_SCOPES.filter((s) => !granted.includes(s));
