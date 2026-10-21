import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { EncryptedSecret } from '@pcp/shared-contracts';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface KeyEncryptionKey {
  version: number;
  key: Buffer;
}

function seal(key: Buffer, plaintext: Buffer, aad: string) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, ciphertext, tag: cipher.getAuthTag() };
}

function open(key: Buffer, iv: Buffer, ciphertext: Buffer, tag: Buffer, aad: string): Buffer {
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Envelope encryption (ADR 0004): a fresh 256-bit data key encrypts the secret; the
 * key-encryption key wraps the data key. `aad` binds the ciphertext to its owner,
 * e.g. "<organizationId>:<connectionId>".
 */
export function encryptSecret(plaintext: Buffer, aad: string, kek: KeyEncryptionKey): EncryptedSecret {
  const dataKey = randomBytes(32);
  const body = seal(dataKey, plaintext, aad);
  const wrap = seal(kek.key, dataKey, `wrap:${aad}`);
  dataKey.fill(0);
  return {
    ciphertext: body.ciphertext,
    iv: body.iv,
    tag: body.tag,
    wrappedKey: Buffer.concat([wrap.iv, wrap.tag, wrap.ciphertext]),
    keyVersion: kek.version,
    algorithm: 'AES-256-GCM',
  };
}

export function decryptSecret(secret: EncryptedSecret, aad: string, keyRing: Map<number, Buffer>): Buffer {
  const kek = keyRing.get(secret.keyVersion);
  if (!kek) throw new Error(`no master key for key version ${secret.keyVersion}`);
  const w = secret.wrappedKey;
  const dataKey = open(
    kek,
    w.subarray(0, IV_BYTES),
    w.subarray(IV_BYTES + TAG_BYTES),
    w.subarray(IV_BYTES, IV_BYTES + TAG_BYTES),
    `wrap:${aad}`,
  );
  try {
    return open(dataKey, secret.iv, secret.ciphertext, secret.tag, aad);
  } finally {
    dataKey.fill(0);
  }
}

/** Compact string form for a text column. */
export function serializeSecret(s: EncryptedSecret): string {
  return JSON.stringify({
    v: s.keyVersion,
    alg: s.algorithm,
    iv: s.iv.toString('base64'),
    tag: s.tag.toString('base64'),
    key: s.wrappedKey.toString('base64'),
    ct: s.ciphertext.toString('base64'),
  });
}

export function deserializeSecret(text: string): EncryptedSecret {
  const o = JSON.parse(text) as { v: number; alg: string; iv: string; tag: string; key: string; ct: string };
  if (o.alg !== 'AES-256-GCM') throw new Error(`unsupported secret algorithm ${o.alg}`);
  return {
    keyVersion: o.v,
    algorithm: 'AES-256-GCM',
    iv: Buffer.from(o.iv, 'base64'),
    tag: Buffer.from(o.tag, 'base64'),
    wrappedKey: Buffer.from(o.key, 'base64'),
    ciphertext: Buffer.from(o.ct, 'base64'),
  };
}
