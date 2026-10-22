import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sealCredentials } from './seal';

const vector = JSON.parse(
  readFileSync(
    new URL('../../../packages/agent-protocol/testdata/sealed-credentials.json', import.meta.url),
    'utf8',
  ),
) as {
  recipientPrivateKey: string;
  recipientPublicKey: string;
  sealed: string;
  plaintext: Record<string, string>;
};

const bytes = (b64: string) => Uint8Array.from(Buffer.from(b64, 'base64'));
const b64url = (u8: Uint8Array) => Buffer.from(u8).toString('base64url');

/** What the agent does (control.OpenSealed), written against WebCrypto for the test. */
async function open(sealedB64: string, privateB64: string, publicB64: string) {
  const { subtle } = globalThis.crypto;
  const raw = bytes(sealedB64);
  const ephPub = raw.slice(0, 32);
  const priv = await subtle.importKey(
    'jwk',
    { kty: 'OKP', crv: 'X25519', d: b64url(bytes(privateB64)), x: b64url(bytes(publicB64)) },
    { name: 'X25519' },
    false,
    ['deriveBits'],
  );
  const eph = await subtle.importKey('raw', ephPub, { name: 'X25519' }, false, []);
  const shared = await subtle.deriveBits({ name: 'X25519', public: eph }, priv, 256);
  const hk = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const key = await subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array([...ephPub, ...bytes(publicB64)]),
      info: new TextEncoder().encode('pcp-pack-credentials-v1'),
    },
    hk,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
  const plain = await subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(32, 44) }, key, raw.slice(44));
  return JSON.parse(new TextDecoder().decode(plain)) as Record<string, string>;
}

describe('sealCredentials (D24)', () => {
  it('the test opener matches the agent (shared vector the Go agent opens)', async () => {
    expect(await open(vector.sealed, vector.recipientPrivateKey, vector.recipientPublicKey)).toEqual(
      vector.plaintext,
    );
  });

  it('seals to the agent key so only that key opens it', async () => {
    const fields = { username: 'pcp_monitor', password: 'päss "w0rd"' };
    const sealed = await sealCredentials(vector.recipientPublicKey, fields);
    expect(sealed).not.toContain('w0rd');
    expect(Buffer.from(sealed, 'base64').toString('latin1')).not.toContain('w0rd');
    expect(await open(sealed, vector.recipientPrivateKey, vector.recipientPublicKey)).toEqual(fields);
    expect(await sealCredentials(vector.recipientPublicKey, fields)).not.toBe(sealed); // fresh ephemeral key and nonce
  });

  it('rejects a key that is not 32 bytes', async () => {
    await expect(sealCredentials(Buffer.alloc(16).toString('base64'), { a: 'b' })).rejects.toThrow(
      /public key/,
    );
  });
});
