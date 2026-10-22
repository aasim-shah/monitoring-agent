import { describe, expect, it } from 'vitest';
import { CircuitBreaker } from './index.js';

describe('CircuitBreaker', () => {
  it('opens after 5 consecutive failures and half-opens after 30 s', async () => {
    let now = 0;
    const breaker = new CircuitBreaker({ now: () => now });
    const fail = () => Promise.reject(new Error('down'));
    for (let i = 0; i < 5; i++) await expect(breaker.run(fail)).rejects.toThrow('down');
    await expect(breaker.run(async () => 'x')).rejects.toMatchObject({ reason: 'provider_unavailable' });
    now = 30_001;
    await expect(breaker.run(async () => 'ok')).resolves.toBe('ok');
    await expect(breaker.run(async () => 'again')).resolves.toBe('again');
  });

  it('a failed trial while half-open reopens it', async () => {
    let now = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 1, now: () => now });
    await expect(breaker.run(() => Promise.reject(new Error('down')))).rejects.toThrow();
    now = 30_001;
    await expect(breaker.run(() => Promise.reject(new Error('still down')))).rejects.toThrow('still down');
    await expect(breaker.run(async () => 'x')).rejects.toMatchObject({ reason: 'provider_unavailable' });
  });
});
