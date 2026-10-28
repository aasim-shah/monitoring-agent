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
  | 'needs_google_sign_in'
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
  needs_google_sign_in: 'Needs Continue with Google',
  available: 'Available',
  permission_denied: 'Access not granted',
  pending_platform_approval: 'Pending platform approval',
  not_read_yet: 'Not read yet',
};

/** A service account key (no Google sign-in) instead of an OAuth grant. */
export const isServiceAccountEmail = (email: string | null | undefined) =>
  Boolean(email?.endsWith('.gserviceaccount.com'));

/** Where the customer adds the service account email so each service can be read. */
export const SERVICE_ACCOUNT_STEPS: Array<[service: string, where: string]> = [
  ['GA4', 'Admin → Property access management → add the email as Viewer'],
  ['Search Console', 'Settings → Users and permissions → add the email (Restricted)'],
  ['Firebase', 'Google Cloud console → IAM → grant the email the Viewer role on the project'],
  ['Play vitals', 'Play Console → Users and permissions → invite the email (view app information)'],
];

export const serviceStatuses = (granted: readonly string[], serviceAccount = false) =>
  GOOGLE_SERVICES.map((s) => ({
    ...s,
    status:
      serviceAccount && s.key === 'ads'
        ? ('needs_google_sign_in' as const)
        : granted.includes(s.scope)
          ? s.whenGranted
          : ('permission_denied' as const),
  }));
