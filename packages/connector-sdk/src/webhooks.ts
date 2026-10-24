import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** What a provider sent, with the exact bytes its signature covers. */
export interface WebhookRequest {
  /** Lower-case header names. */
  headers: Record<string, string>;
  rawBody: Buffer;
  payload: unknown;
}

/** A verified delivery: its provider delivery ID (for idempotency) and event type. */
export type WebhookCheck = { ok: false } | { ok: true; deliveryId: string; eventType: string };

/** Constant-time string comparison (false for different lengths). */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export const hmacSha256Hex = (secret: string, body: Buffer) =>
  createHmac('sha256', secret).update(body).digest('hex');

/** A stable delivery ID when the provider sends none: the body's SHA-256. */
export const bodyDigest = (body: Buffer) => createHash('sha256').update(body).digest('hex');
