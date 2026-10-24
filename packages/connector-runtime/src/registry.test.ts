import { describe, expect, it } from 'vitest';
import { buildRegistry } from './index.js';

describe('buildRegistry', () => {
  it('registers no test connectors by default', async () => {
    expect((await buildRegistry({})).list().map((c) => c.type)).not.toContain('mock');
  });

  it('adds the mock connector only when explicitly enabled outside production', async () => {
    const registry = await buildRegistry({ PCP_ENABLE_MOCK_CONNECTOR: '1', NODE_ENV: 'test' });
    expect(registry.has('mock')).toBe(true);
  });

  it('refuses the mock connector in production', async () => {
    await expect(buildRegistry({ PCP_ENABLE_MOCK_CONNECTOR: '1', NODE_ENV: 'production' })).rejects.toThrow(
      /production/,
    );
  });

  it('registers the M7 provider connectors', async () => {
    const types = (await buildRegistry({})).list().map((c) => c.type);
    expect(types).toEqual(expect.arrayContaining(['cloudflare', 'github', 'prometheus', 'grafana']));
  });

  it('points providers at test servers only with the explicit test flag', async () => {
    await expect(buildRegistry({ PCP_CLOUDFLARE_API_URL: 'http://fake:9000' })).rejects.toThrow(
      /PCP_ALLOW_TEST_PROVIDERS/,
    );
    const registry = await buildRegistry({
      PCP_CLOUDFLARE_API_URL: 'http://fake:9000',
      PCP_ALLOW_TEST_PROVIDERS: '1',
    });
    expect(registry.has('cloudflare')).toBe(true);
  });
});
