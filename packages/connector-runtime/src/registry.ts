import { ConnectorRegistry, type Connector } from '@pcp/connector-sdk';
import { customHttpConnector } from '@pcp/connectors-custom-http';
import { mongodbConnector, mysqlConnector, postgresConnector } from '@pcp/connectors-databases';

/** Production connectors. Providers join this list as their milestones land (M7, M8, M13). */
const PRODUCTION_CONNECTORS: Connector[] = [
  postgresConnector,
  mysqlConnector,
  mongodbConnector,
  customHttpConnector,
];

/**
 * Builds the connector registry for an app. The test-only mock connector is a dev
 * dependency, loaded only when PCP_ENABLE_MOCK_CONNECTOR=1 and never in production.
 */
export async function buildRegistry(env: Record<string, string | undefined>): Promise<ConnectorRegistry> {
  const registry = new ConnectorRegistry();
  for (const c of PRODUCTION_CONNECTORS) registry.register(c);
  if (env.PCP_ENABLE_MOCK_CONNECTOR === '1') {
    if (env.NODE_ENV === 'production') {
      throw new Error('PCP_ENABLE_MOCK_CONNECTOR is not allowed in production');
    }
    const { mockConnector } = await import('@pcp/connectors-mock');
    registry.register(mockConnector);
  }
  return registry;
}
