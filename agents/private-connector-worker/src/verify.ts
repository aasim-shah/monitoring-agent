import { createPublicKey, verify } from 'node:crypto';
import { canonicalJson } from '@pcp/agent-protocol';

export type Verdict =
  | { ok: true }
  | { ok: false; reason: 'unsigned' | 'bad signature' | 'expired' | 'malformed' };

/**
 * A task runs only if the control plane signed it (Ed25519 over the canonical JSON of the
 * task without `signature`) and it has not expired (BR-07-05, BR-03-07).
 */
export function verifyTask(task: Record<string, unknown>, publicKeyB64: string, now = new Date()): Verdict {
  const { signature, ...unsigned } = task;
  if (typeof signature !== 'string' || !signature) return { ok: false, reason: 'unsigned' };
  let message: Buffer;
  try {
    message = Buffer.from(canonicalJson(unsigned));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const key = createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(publicKeyB64, 'base64').toString('base64url') },
    format: 'jwk',
  });
  if (!verify(null, message, key, Buffer.from(signature, 'base64')))
    return { ok: false, reason: 'bad signature' };
  const expires = Date.parse(String(unsigned.expiresAt));
  if (!Number.isFinite(expires) || expires <= now.getTime()) return { ok: false, reason: 'expired' };
  return { ok: true };
}
