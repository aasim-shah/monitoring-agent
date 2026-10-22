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
});
