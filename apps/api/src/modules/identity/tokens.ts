import { createHash, randomBytes } from 'node:crypto';

/** 256-bit random token, base64url (43 characters). */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Tokens are stored only as SHA-256 hex digests. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
