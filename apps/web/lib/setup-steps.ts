export type SetupStepStatus = 'done' | 'todo' | 'soon';

export interface SetupStep {
  id: string;
  title: string;
  description: string;
  /** What the platform reads once this step is connected (spec §6.3). */
  collects: string;
  status: SetupStepStatus;
  /** Where to act; absent while the step is not built yet. */
  href?: string;
  actionLabel?: string;
}

interface SetupInput {
  orgId: string;
  productId: string;
  environments: number;
  canManage: boolean;
}

/**
 * The path from a new product to full monitoring (spec §6). Steps whose screens are not
 * built yet are listed as "soon" so customers always see what comes next.
 */
export function buildSetupSteps(input: SetupInput): SetupStep[] {
  return [
    {
      id: 'environments',
      title: 'Add environments',
      description: 'Separate Production from Staging so alerts and dashboards stay apart.',
      collects: 'Nothing yet: environments organize everything you connect next.',
      status: input.environments > 0 ? 'done' : 'todo',
    },
    {
      id: 'servers',
      title: 'Add your servers',
      description:
        'Copy one install command and run it on each VPS. The agent appears within a minute and detects Redis, Kafka, PostgreSQL, Node.js, and other services.',
      collects: 'CPU, memory, disk, network, service health and metrics, and logs you choose.',
      status: 'soon',
    },
    {
      id: 'google',
      title: 'Connect Google',
      description:
        'Sign in with Google and approve read-only access, then pick the Cloud projects, GA4 properties, and Search Console sites to monitor.',
      collects: 'Google Cloud resources and metrics, Analytics traffic, Search Console performance.',
      status: 'soon',
    },
    {
      id: 'databases',
      title: 'Connect databases',
      description:
        'Through an agent inside your network, give a read-only database user. No database port is exposed to us.',
      collects: 'Connections, slow queries, replication lag, table sizes, and growth.',
      status: 'soon',
    },
    {
      id: 'code-and-cloud',
      title: 'Connect GitHub and Cloudflare',
      description: 'Authorize read-only access to link deployments and DNS to what is running.',
      collects: 'Repositories, deployments, workflow runs, DNS records, and edge traffic.',
      status: 'soon',
    },
    {
      id: 'websites',
      title: 'Monitor websites and APIs',
      description: "Check your product's domains for uptime, response time, SSL expiry, and broken pages.",
      collects: 'Availability, latency, status codes, certificate expiry, and page errors.',
      status: 'soon',
    },
    {
      id: 'team',
      title: 'Invite your team',
      description: 'Give engineers and analysts their own access with the right role.',
      collects: 'Nothing: members only see what their role and products allow.',
      status: 'todo',
      href: `/orgs/${input.orgId}/members`,
      actionLabel: 'Invite your team',
    },
  ];
}
