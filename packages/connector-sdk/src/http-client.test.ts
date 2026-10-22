import { describe, expect, it, vi } from 'vitest';
import { ConnectorError, createHttpClient } from './index.js';

const reply = (status: number, body = '', headers: Record<string, string> = {}) =>
  new Response(body, { status, headers });

describe('bounded HTTP client', () => {
  it('retries 503 and returns the eventual success', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(reply(503)).mockResolvedValueOnce(reply(200, '{"ok":true}'));
    const sleep = vi.fn(async () => {});
    const res = await createHttpClient({ fetch, sleep }).request('https://api.example.com/x');
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('honors Retry-After seconds', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(reply(429, '', { 'retry-after': '2' }))
      .mockResolvedValueOnce(reply(200));
    const sleep = vi.fn(async () => {});
    await createHttpClient({ fetch, sleep }).request('https://api.example.com/x');
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('gives up after 3 retries with a rate_limited or provider_unavailable reason', async () => {
    const fetch = vi.fn().mockResolvedValue(reply(429, '', { 'retry-after': '1' }));
    const client = createHttpClient({ fetch, sleep: async () => {} });
    await expect(client.request('https://api.example.com/x')).rejects.toMatchObject({
      reason: 'rate_limited',
      retryAfterSeconds: 1,
    });
    expect(fetch).toHaveBeenCalledTimes(4);

    const down = vi.fn().mockResolvedValue(reply(502));
    await expect(
      createHttpClient({ fetch: down, sleep: async () => {} }).request('https://x'),
    ).rejects.toBeInstanceOf(ConnectorError);
  });

  it('does not retry client errors', async () => {
    const fetch = vi.fn().mockResolvedValue(reply(401, 'nope'));
    const res = await createHttpClient({ fetch, sleep: async () => {} }).request('https://x');
    expect(res.status).toBe(401);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('aborts bodies above the size limit', async () => {
    const fetch = vi.fn().mockResolvedValue(reply(200, 'x'.repeat(2048)));
    await expect(
      createHttpClient({ fetch, maxBytes: 1024, sleep: async () => {} }).request('https://x'),
    ).rejects.toThrow(/exceeds 1024 bytes/);
  });
});
