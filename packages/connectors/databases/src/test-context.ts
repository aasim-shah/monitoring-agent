import type { ExecutionContext } from '@pcp/connector-sdk';

/** An ExecutionContext as the private worker builds it (credentials from the local secret file). */
export function testContext(
  config: Record<string, unknown>,
  creds: Record<string, string>,
): ExecutionContext {
  return {
    authenticatedOrganizationId: 'org',
    connectionId: 'conn',
    executionLocation: 'private',
    requestId: 'req',
    deadline: new Date(Date.now() + 30_000).toISOString(),
    config,
    credentials: async () => creds,
  };
}
