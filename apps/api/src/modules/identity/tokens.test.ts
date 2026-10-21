import { describe, expect, it } from 'vitest';
import { hashToken, randomToken } from './tokens.js';

describe('tokens', () => {
  it('creates 256-bit base64url tokens', () => {
    const t = randomToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(t);
  });
  it('hashes tokens with SHA-256 hex', () => {
    expect(hashToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
