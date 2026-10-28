import { createPrivateKey, createSign } from 'node:crypto';

/** The fields of a Google Cloud service account JSON key that the platform uses. */
export interface ServiceAccountKey {
  clientEmail: string;
  privateKey: string;
  projectId: string | null;
}

export const SERVICE_ACCOUNT_KEY_MAX_BYTES = 16 * 1024;
export const SERVICE_ACCOUNT_AUDIENCE = 'https://oauth2.googleapis.com/token';

/**
 * Parses an uploaded key file. Throws an Error whose message can be shown to the member; the
 * message never contains the key itself.
 */
export function parseServiceAccountKey(text: string): ServiceAccountKey {
  if (Buffer.byteLength(text, 'utf8') > SERVICE_ACCOUNT_KEY_MAX_BYTES)
    throw new Error('This file is too large to be a service account key');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('This file is not JSON; download the key again as JSON');
  }
  const k = raw as Record<string, unknown> | null;
  if (!k || typeof k !== 'object' || k.type !== 'service_account')
    throw new Error('This is not a service account key (its "type" is not "service_account")');
  const clientEmail = typeof k.client_email === 'string' ? k.client_email.trim().toLowerCase() : '';
  const privateKey = typeof k.private_key === 'string' ? k.private_key : '';
  if (!clientEmail.endsWith('.gserviceaccount.com'))
    throw new Error('The key has no service account email (client_email)');
  try {
    createPrivateKey(privateKey);
  } catch {
    throw new Error('The key has no valid private key (private_key)');
  }
  return {
    clientEmail,
    privateKey,
    projectId: typeof k.project_id === 'string' ? k.project_id : null,
  };
}

/** A signed JWT for the OAuth 2.0 JWT bearer grant (RFC 7523), valid for one hour. */
export function serviceAccountAssertion(
  key: ServiceAccountKey,
  scopes: readonly string[],
  now: Date,
): string {
  const iat = Math.floor(now.getTime() / 1000);
  const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    iss: key.clientEmail,
    scope: scopes.join(' '),
    aud: SERVICE_ACCOUNT_AUDIENCE,
    iat,
    exp: iat + 3600,
  })}`;
  return `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(key.privateKey, 'base64url')}`;
}
