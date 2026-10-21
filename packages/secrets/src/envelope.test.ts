import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptSecret, deserializeSecret, encryptSecret, loadKeyRing, serializeSecret } from './index.js';

const k1 = { version: 1, key: randomBytes(32) };
const k2 = { version: 2, key: randomBytes(32) };
const ring = new Map([
  [1, k1.key],
  [2, k2.key],
]);
const aad = 'org-1:conn-1';
const plain = Buffer.from('cf-token-secret');

describe('envelope encryption', () => {
  it('round-trips and records the key version', () => {
    const s = encryptSecret(plain, aad, k2);
    expect(s.keyVersion).toBe(2);
    expect(s.algorithm).toBe('AES-256-GCM');
    expect(s.ciphertext.includes(plain)).toBe(false);
    expect(decryptSecret(s, aad, ring)).toEqual(plain);
  });

  it.each(['ciphertext', 'tag', 'wrappedKey'] as const)('rejects tampered %s', (field) => {
    const s = encryptSecret(plain, aad, k1);
    const copy = Buffer.from(s[field]);
    copy[0] = copy[0]! ^ 0xff;
    expect(() => decryptSecret({ ...s, [field]: copy }, aad, ring)).toThrow();
  });

  it('rejects the wrong AAD (secret copied to another row)', () => {
    const s = encryptSecret(plain, aad, k1);
    expect(() => decryptSecret(s, 'org-2:conn-1', ring)).toThrow();
  });

  it('decrypts a v1 secret after the active key becomes v2', () => {
    const old = encryptSecret(plain, aad, k1);
    expect(decryptSecret(old, aad, ring)).toEqual(plain);
  });

  it('fails clearly when the key version is unknown', () => {
    const s = encryptSecret(plain, aad, { version: 9, key: randomBytes(32) });
    expect(() => decryptSecret(s, aad, ring)).toThrow(/key version 9/);
  });

  it('serializes to a string and back', () => {
    const s = encryptSecret(plain, aad, k1);
    const text = serializeSecret(s);
    expect(typeof text).toBe('string');
    expect(decryptSecret(deserializeSecret(text), aad, ring)).toEqual(plain);
  });
});

describe('loadKeyRing', () => {
  const b64 = (b: Buffer) => b.toString('base64');

  it('loads the active key and older versions', () => {
    const r = loadKeyRing({ MASTER_KEY: b64(k2.key), MASTER_KEY_VERSION: '2', MASTER_KEY_V1: b64(k1.key) });
    expect(r.active.version).toBe(2);
    expect(r.ring.get(1)).toEqual(k1.key);
    expect(r.ring.get(2)).toEqual(k2.key);
  });

  it('defaults to version 1', () => {
    expect(loadKeyRing({ MASTER_KEY: b64(k1.key) }).active.version).toBe(1);
  });

  it('rejects a missing or short key', () => {
    expect(() => loadKeyRing({})).toThrow(/MASTER_KEY/);
    expect(() => loadKeyRing({ MASTER_KEY: b64(randomBytes(16)) })).toThrow(/32 bytes/);
  });
});
