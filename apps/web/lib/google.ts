/** Google data scopes and services as the connection page shows them (mirrors @pcp/connectors-google). */
const P = 'https://www.googleapis.com/auth/';

export const GOOGLE_SCOPE_PURPOSES: Array<[scope: string, purpose: string]> = [
  [`${P}analytics.readonly`, 'GA4 reports: users, sessions, events, traffic sources'],
  [`${P}analytics.manage.users.readonly`, 'Who can see each GA4 property (read-only)'],
  [`${P}adwords`, 'Google Ads performance (read only; the platform never changes campaigns)'],
  [`${P}firebase.readonly`, 'Firebase projects and apps'],
  [`${P}cloud-platform.read-only`, 'Google Cloud project metadata'],
  [`${P}monitoring.read`, 'Cloud Monitoring metrics'],
  [`${P}logging.read`, 'Cloud Logging entries'],
  [`${P}bigquery.readonly`, 'Crashlytics, Performance, and GA4 exports in BigQuery'],
  [`${P}playdeveloperreporting`, 'Play Console Android vitals: crash and ANR rates'],
  [`${P}webmasters.readonly`, 'Search Console: clicks, impressions, positions'],
  [`${P}tagmanager.readonly`, 'Tag Manager containers'],
];

export const GOOGLE_SCOPES = GOOGLE_SCOPE_PURPOSES.map(([s]) => s);

export type GoogleServiceStatus =
  | 'available'
  | 'permission_denied'
  | 'pending_platform_approval'
  | 'not_read_yet';

export const GOOGLE_SERVICES: Array<{
  key: string;
  label: string;
  scope: string;
  whenGranted: GoogleServiceStatus;
}> = [
  { key: 'ga4', label: 'GA4', scope: `${P}analytics.readonly`, whenGranted: 'available' },
  {
    key: 'searchConsole',
    label: 'Search Console',
    scope: `${P}webmasters.readonly`,
    whenGranted: 'available',
  },
  { key: 'firebase', label: 'Firebase', scope: `${P}firebase.readonly`, whenGranted: 'available' },
  { key: 'play', label: 'Play vitals', scope: `${P}playdeveloperreporting`, whenGranted: 'available' },
  // Ads needs the platform's developer token (M13.4); BigQuery exports are not read yet.
  { key: 'ads', label: 'Google Ads', scope: `${P}adwords`, whenGranted: 'pending_platform_approval' },
  { key: 'bigquery', label: 'BigQuery exports', scope: `${P}bigquery.readonly`, whenGranted: 'not_read_yet' },
];

export const STATUS_LABEL: Record<GoogleServiceStatus, string> = {
  available: 'Available',
  permission_denied: 'Access not granted',
  pending_platform_approval: 'Pending platform approval',
  not_read_yet: 'Not read yet',
};

export const serviceStatuses = (granted: readonly string[]) =>
  GOOGLE_SERVICES.map((s) => ({
    ...s,
    status: granted.includes(s.scope) ? s.whenGranted : ('permission_denied' as const),
  }));
