/**
 * Seals pack credentials in the browser to the agent's X25519 key (D24, BR-11-03): ECIES
 * with X25519, HKDF-SHA256 (salt = ephemeral public || agent public, info
 * "pcp-pack-credentials-v1"), and AES-256-GCM. The control plane stores only the result
 * and cannot open it; the agent opens it with control.OpenSealed.
 */
const INFO = new TextEncoder().encode('pcp-pack-credentials-v1');

const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toB64 = (u8: Uint8Array) => btoa(String.fromCharCode(...u8));

export async function sealCredentials(
  agentPublicKeyB64: string,
  fields: Record<string, string>,
): Promise<string> {
  const { subtle } = globalThis.crypto;
  const agentPub = fromB64(agentPublicKeyB64);
  if (agentPub.length !== 32) throw new Error('The agent public key is not a 32-byte X25519 key');
  const recipient = await subtle.importKey('raw', agentPub, { name: 'X25519' }, false, []);
  const eph = (await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as CryptoKeyPair;
  const ephPub = new Uint8Array(await subtle.exportKey('raw', eph.publicKey));
  const shared = await subtle.deriveBits({ name: 'X25519', public: recipient }, eph.privateKey, 256);
  const hkdf = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const key = await subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array([...ephPub, ...agentPub]), info: INFO },
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await subtle.encrypt(
      { name: 'AES-GCM', iv: nonce },
      key,
      new TextEncoder().encode(JSON.stringify(fields)),
    ),
  );
  return toB64(new Uint8Array([...ephPub, ...nonce, ...ciphertext]));
}
