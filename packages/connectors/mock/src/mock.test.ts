import { describe, expect, it } from 'vitest';
import { ConnectorRegistry, type ExecutionContext } from '@pcp/connector-sdk';
import { mockConnector } from './index.js';

const ctx = (behavior: string, resources = 2): ExecutionContext => ({
  authenticatedOrganizationId: 'org',
  connectionId: 'conn',
  executionLocation: 'cloud',
  requestId: 'req',
  deadline: new Date(Date.now() + 30_000).toISOString(),
  config: { behavior, resources },
  credentials: async () => ({ token: 'mock-secret-token' }),
});

describe('mock connector', () => {
  it('registers cleanly', () => {
    expect(() => new ConnectorRegistry().register(mockConnector)).not.toThrow();
  });

  it('validates per behavior', async () => {
    await expect(mockConnector.validate(ctx('ok'))).resolves.toEqual({ ok: true, accountId: 'mock-account' });
    await expect(mockConnector.validate(ctx('forbidden'))).resolves.toEqual({
      ok: false,
      missingPermissions: ['mock:read'],
    });
    await expect(mockConnector.validate(ctx('unauthorized'))).rejects.toMatchObject({
      reason: 'reauthorization_required',
    });
    await expect(mockConnector.validate(ctx('rate_limited'))).rejects.toMatchObject({
      reason: 'rate_limited',
      retryAfterSeconds: 30,
    });
    await expect(mockConnector.validate(ctx('unavailable'))).rejects.toMatchObject({
      reason: 'provider_unavailable',
    });
    await expect(mockConnector.validate(ctx('leaky'))).rejects.toThrow(/mock-secret-token/);
  });

  it('discovers the configured number of resources', async () => {
    const page = await mockConnector.discover!(ctx('ok', 3));
    expect(page.observations).toHaveLength(3);
    expect(page.observations[0]).toMatchObject({
      provider: 'mock',
      resourceType: 'mock_resource',
      externalId: 'mock-1',
    });
  });

  it('validates its config', () => {
    expect(mockConnector.validateConfig!({ behavior: 'ok' })).toEqual({ ok: true });
    expect(mockConnector.validateConfig!({ behavior: 'explode' }).ok).toBe(false);
  });
});
