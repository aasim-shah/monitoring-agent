import { describe, expect, it } from 'vitest';
import { runChecks, type ReadinessCheck } from './index.js';

const ok = (name: string): ReadinessCheck => ({ name, check: async () => {} });

describe('runChecks', () => {
  it('is ok when every check passes', async () => {
    await expect(runChecks([ok('postgres'), ok('redis')])).resolves.toEqual({
      ok: true,
      results: [
        { name: 'postgres', ok: true },
        { name: 'redis', ok: true },
      ],
    });
  });

  it('reports a throwing check with its message', async () => {
    const failing: ReadinessCheck = {
      name: 'postgres',
      check: async () => {
        throw new Error('connection refused');
      },
    };
    const result = await runChecks([failing, ok('redis')]);
    expect(result.ok).toBe(false);
    expect(result.results[0]).toEqual({ name: 'postgres', ok: false, error: 'connection refused' });
    expect(result.results[1]).toEqual({ name: 'redis', ok: true });
  });

  it('times out a hanging check', async () => {
    const hanging: ReadinessCheck = { name: 'redis', check: () => new Promise(() => {}) };
    const result = await runChecks([hanging], 50);
    expect(result).toEqual({
      ok: false,
      results: [{ name: 'redis', ok: false, error: 'timed out after 50 ms' }],
    });
  });
});
