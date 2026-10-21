import type { KeyEncryptionKey } from './envelope.js';

export interface KeyRing {
  active: KeyEncryptionKey;
  ring: Map<number, Buffer>;
}

function decodeKey(name: string, value: string): Buffer {
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32)
    throw new Error(`${name} must be 32 bytes, base64-encoded (got ${key.length} bytes)`);
  return key;
}

/**
 * Reads MASTER_KEY (active, version MASTER_KEY_VERSION, default 1) and any older
 * keys MASTER_KEY_V<n> kept for decryption during rotation.
 */
export function loadKeyRing(env: Record<string, string | undefined>): KeyRing {
  if (!env.MASTER_KEY) throw new Error('MASTER_KEY must be set (32 random bytes, base64)');
  const version = Number(env.MASTER_KEY_VERSION ?? '1');
  if (!Number.isInteger(version) || version < 1)
    throw new Error('MASTER_KEY_VERSION must be a positive integer');
  const active = { version, key: decodeKey('MASTER_KEY', env.MASTER_KEY) };
  const ring = new Map<number, Buffer>([[version, active.key]]);
  for (const [name, value] of Object.entries(env)) {
    const m = /^MASTER_KEY_V(\d+)$/.exec(name);
    if (m && value) ring.set(Number(m[1]), decodeKey(name, value));
  }
  return { active, ring };
}
