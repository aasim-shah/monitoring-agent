import { createAwsConnector } from '@pcp/connectors-aws';
import { ConnectorRegistry, type Connector, type DestinationOptions } from '@pcp/connector-sdk';
import { createCloudflareConnector } from '@pcp/connectors-cloudflare';
import { customHttpConnector } from '@pcp/connectors-custom-http';
import { createGithubConnector } from '@pcp/connectors-github';
import { createGoogleConnector } from '@pcp/connectors-google';
import { grafanaConnector } from '@pcp/connectors-grafana';
import { prometheusConnector } from '@pcp/connectors-prometheus';
import { mongodbConnector, mysqlConnector, postgresConnector } from '@pcp/connectors-databases';

/**
 * Provider API base URLs a test stack may point at local fake servers. Honored only with
 * PCP_ALLOW_TEST_PROVIDERS=1, which no production configuration sets; private destinations are
 * then allowed for exactly that host and port.
 */
const PROVIDER_URL_VARS = {
  cloudflare: 'PCP_CLOUDFLARE_API_URL',
  github: 'PCP_GITHUB_API_URL',
  google: 'PCP_GOOGLE_API_URL',
} as const;

function provider(
  env: Record<string, string | undefined>,
  name: keyof typeof PROVIDER_URL_VARS,
): { baseUrl?: string; destination?: DestinationOptions } {
  const url = env[PROVIDER_URL_VARS[name]];
  if (!url) return {};
  if (env.PCP_ALLOW_TEST_PROVIDERS !== '1')
    throw new Error(
      `${PROVIDER_URL_VARS[name]} is for test stacks only and needs PCP_ALLOW_TEST_PROVIDERS=1`,
    );
  const u = new URL(url);
  return {
    baseUrl: url,
    destination: { allowPrivate: true, allowlist: [`${u.hostname}:${u.port || '80'}`] },
  };
}

/**
 * Builds the connector registry for an app. The test-only mock connector is a dev
 * dependency, loaded only when PCP_ENABLE_MOCK_CONNECTOR=1 and never in production.
 */
export async function buildRegistry(env: Record<string, string | undefined>): Promise<ConnectorRegistry> {
  const registry = new ConnectorRegistry();
  /** Production connectors. Providers join this list as their milestones land (M7, M8, M13). */
  const production: Connector[] = [
    createAwsConnector(),
    postgresConnector,
    mysqlConnector,
    mongodbConnector,
    customHttpConnector,
    createCloudflareConnector(provider(env, 'cloudflare')),
    createGithubConnector(provider(env, 'github')),
    prometheusConnector,
    grafanaConnector,
  ];
  // Google needs the platform's OAuth client (the same one as Google sign-in, separate scopes).
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    const test = provider(env, 'google');
    production.push(
      createGoogleConnector({
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        ...(test.baseUrl ? { apiUrl: test.baseUrl, destination: test.destination } : {}),
      }),
    );
  }
  for (const c of production) registry.register(c);
  if (env.PCP_ENABLE_MOCK_CONNECTOR === '1') {
    if (env.NODE_ENV === 'production') {
      throw new Error('PCP_ENABLE_MOCK_CONNECTOR is not allowed in production');
    }
    const { mockConnector } = await import('@pcp/connectors-mock');
    registry.register(mockConnector);
  }
  return registry;
}
