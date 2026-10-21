import { describe, expect, it } from 'vitest';
import { base32Encode, generateTotpSecret, otpauthUri, totp, verifyTotp } from './totp.js';

// RFC 6238 Appendix B, SHA-1, secret "12345678901234567890".
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('TOTP', () => {
  it('encodes the RFC secret in base32', () => {
    expect(RFC_SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
  ])('matches RFC 6238 vector at T=%i', (t, expected) => {
    expect(totp(RFC_SECRET, t, 8)).toBe(expected);
  });

  it('accepts ±1 time step and rejects ±2', () => {
    const now = 1_700_000_000;
    const code = totp(RFC_SECRET, now);
    expect(verifyTotp(RFC_SECRET, code, now + 30)).toBe(true);
    expect(verifyTotp(RFC_SECRET, code, now - 30)).toBe(true);
    expect(verifyTotp(RFC_SECRET, code, now + 60)).toBe(false);
    expect(verifyTotp(RFC_SECRET, '000000x', now)).toBe(false);
  });

  it('generates 20-byte base32 secrets and an otpauth URI', () => {
    const s = generateTotpSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(otpauthUri(s, 'a@example.com')).toBe(
      `otpauth://totp/Product%20Control%20Plane:a%40example.com?secret=${s}&issuer=Product%20Control%20Plane&algorithm=SHA1&digits=6&period=30`,
    );
  });
});
