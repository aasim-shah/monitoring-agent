import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startRedis, type TestRedis } from '@pcp/test-support';
import { RateLimiter } from './rate-limiter.js';

let server: TestRedis;
let redis: Redis;

beforeAll(async () => {
  server = await startRedis();
  redis = new Redis(server.url);
}, 120_000);

afterAll(async () => {
  redis?.disconnect();
  await server?.stop();
});

describe('RateLimiter', () => {
  it('allows 10 hits per window and denies the 11th', async () => {
    const limiter = new RateLimiter(redis);
    for (let i = 0; i < 10; i++) expect((await limiter.hit('login:1.2.3.4')).allowed).toBe(true);
    const denied = await limiter.hit('login:1.2.3.4');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('tracks keys independently', async () => {
    const limiter = new RateLimiter(redis);
    for (let i = 0; i < 11; i++) await limiter.hit('login:5.6.7.8');
    expect((await limiter.hit('login:9.9.9.9')).allowed).toBe(true);
  });
});
