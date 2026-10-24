/** What each SaaS integration asks for and does, shown before anyone pastes a token (WB-06 UC-06-02). */
export interface IntegrationSpec {
  provider: 'cloudflare' | 'github' | 'prometheus' | 'grafana' | 'google';
  /** Connected through the provider's sign-in, not a pasted token (Google, M13b). */
  oauth?: boolean;
  title: string;
  summary: string;
  /** Exact permission names as the provider's token screen shows them. */
  permissions: string[];
  optionalPermissions?: string[];
  tokenHelp: string;
  collects: string;
  frequency: string;
  changes: string;
  configFields: Array<{
    name: string;
    label: string;
    placeholder?: string;
    required?: boolean;
    list?: boolean;
    hint?: string;
  }>;
  displayName: (config: Record<string, unknown>) => string;
  /** Inventory types a product can be scoped to; the rest follow them. */
  scopeTypes: string[];
  /** Where to paste the webhook URL and secret, when the provider sends events. */
  webhook?: string;
}

export const INTEGRATIONS: Record<IntegrationSpec['provider'], IntegrationSpec> = {
  cloudflare: {
    provider: 'cloudflare',
    title: 'Cloudflare',
    summary: 'Zones, DNS records, and certificates; DNS changes and security events.',
    permissions: ['Zone: Zone: Read', 'Zone: DNS: Read', 'Zone: SSL and Certificates: Read'],
    optionalPermissions: ['Zone: Cache Purge: Purge (only to allow approved cache purges)'],
    tokenHelp: 'My Profile → API Tokens → Create Token → Custom token. Limit it to the zones you want here.',
    collects: 'Zone names and plans, DNS records, certificate packs and their expiry.',
    frequency: 'Discovery on connect and on demand; health every 5 minutes; events as they happen.',
    changes: 'Cache purge, after approval in Automations & Approvals. Nothing else is changed.',
    configFields: [
      {
        name: 'accountId',
        label: 'Account ID (optional)',
        placeholder: '32-character account ID',
        hint: 'Only needed when the token can see more than one account.',
      },
    ],
    displayName: () => 'Cloudflare',
    scopeTypes: ['cloudflare_zone'],
    webhook:
      'Notifications → Destinations → Webhooks → Create. Paste the URL below and the secret you enter here; then add notifications that use it.',
  },
  github: {
    provider: 'github',
    title: 'GitHub',
    summary: 'Repositories, workflows, deployments, and releases; deployment and workflow events.',
    permissions: [
      'Metadata: Read-only',
      'Contents: Read-only',
      'Actions: Read-only',
      'Deployments: Read-only',
    ],
    optionalPermissions: ['Actions: Read and write (only to allow approved workflow runs)'],
    tokenHelp:
      'Settings → Developer settings → Fine-grained tokens → Generate. Resource owner: the user or organization below; choose the repositories.',
    collects: 'Repository names, default branches, workflows, deployments, and releases.',
    frequency: 'Discovery on connect and on demand; health every 5 minutes; events as they happen.',
    changes: 'Workflow dispatch, after approval in Automations & Approvals. Nothing else is changed.',
    configFields: [
      { name: 'owner', label: 'Owner (user or organization)', placeholder: 'acme', required: true },
      {
        name: 'repositories',
        label: 'Repositories (optional, comma-separated)',
        placeholder: 'shop, api',
        list: true,
        hint: 'Leave empty to use every repository the token can see.',
      },
    ],
    displayName: (c) => `GitHub ${String(c.owner ?? '')}`.trim(),
    scopeTypes: ['github_repository'],
    webhook:
      'Repository or organization Settings → Webhooks → Add webhook. Content type application/json; events: Deployment statuses, Workflow runs, Releases, Pushes.',
  },
  prometheus: {
    provider: 'prometheus',
    title: 'Prometheus',
    summary: 'Use the Prometheus you already run: targets become hosts and services, queried on demand.',
    permissions: ['Read access to /api/v1/query, /api/v1/query_range, and /api/v1/targets'],
    tokenHelp:
      'Use a bearer token or basic-auth user from the proxy in front of Prometheus; leave both empty if it is public.',
    collects: 'Scrape targets and their jobs. Metrics are not copied; queries run when you look.',
    frequency: 'Discovery on connect and on demand; health every 5 minutes.',
    changes: 'None. Read-only.',
    configFields: [
      {
        name: 'baseUrl',
        label: 'Prometheus URL',
        placeholder: 'https://prometheus.example.com',
        required: true,
        hint: 'Reachable from the internet over HTTPS. A private Prometheus needs the private worker (later).',
      },
    ],
    displayName: () => 'Prometheus',
    scopeTypes: ['prometheus_server'],
  },
  grafana: {
    provider: 'grafana',
    title: 'Grafana',
    summary: 'Dashboards, linked from the assets they show.',
    permissions: ['Service account with the Viewer role (Dashboards: Read)'],
    tokenHelp: 'Administration → Service accounts → Add service account (Viewer) → Add token.',
    collects: 'Dashboard titles, folders, and links.',
    frequency: 'Discovery on connect and on demand; health every 5 minutes.',
    changes: 'None. Read-only.',
    configFields: [
      {
        name: 'baseUrl',
        label: 'Grafana URL',
        placeholder: 'https://grafana.example.com',
        required: true,
      },
    ],
    displayName: () => 'Grafana',
    scopeTypes: ['grafana_dashboard'],
  },
  google: {
    provider: 'google',
    oauth: true,
    title: 'Google',
    summary: 'GA4, Search Console, Firebase apps, and Play Android vitals through one read-only sign-in.',
    permissions: [],
    tokenHelp: '',
    collects:
      'Daily GA4, Search Console, and Play vitals values for the properties, sites, and apps you choose.',
    frequency: 'Hourly.',
    changes: 'None. Read-only.',
    configFields: [],
    displayName: () => 'Google',
    scopeTypes: [
      'google_ga4_property',
      'google_search_console_site',
      'google_play_app',
      'google_firebase_app',
    ],
  },
};

export const INTEGRATION_PROVIDERS = Object.keys(INTEGRATIONS) as Array<IntegrationSpec['provider']>;

export const isIntegration = (provider: string): provider is IntegrationSpec['provider'] =>
  provider in INTEGRATIONS;
