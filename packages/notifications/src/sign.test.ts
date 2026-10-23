import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sign, verify } from './sign.js';

const secret = 'whsec-test-secret';
const body = JSON.stringify({ type: 'incident.opened', incident: { id: 'i1' } });

describe('webhook signature (UC-13-10, TC-13-08)', () => {
  it('matches the documented algorithm: v1 = hex HMAC-SHA256(secret, "<t>.<raw body>")', () => {
    const header = sign(secret, body, 1_792_740_000);
    const expected = createHmac('sha256', secret).update(`1792740000.${body}`).digest('hex');
    expect(header).toBe(`t=1792740000,v1=${expected}`);
    expect(verify(secret, body, header, 1_792_740_100)).toBe(true);
  });

  it('rejects a stale timestamp, a changed body, a wrong secret, and garbage', () => {
    const header = sign(secret, body, 1_792_740_000);
    expect(verify(secret, body, header, 1_792_740_000 + 301)).toBe(false);
    expect(verify(secret, body + ' ', header, 1_792_740_010)).toBe(false);
    expect(verify('other', body, header, 1_792_740_010)).toBe(false);
    expect(verify(secret, body, 'v1=abc', 1_792_740_010)).toBe(false);
  });
});
