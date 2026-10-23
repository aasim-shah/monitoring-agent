import { createHmac, timingSafeEqual } from 'node:crypto';

/** Seconds a receiver accepts between our timestamp and its clock (UC-13-10). */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/** `X-PCP-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`. */
export function sign(secret: string, body: string, unixSeconds: number): string {
  const v1 = createHmac('sha256', secret).update(`${unixSeconds}.${body}`).digest('hex');
  return `t=${unixSeconds},v1=${v1}`;
}

/** The receiver side of the documented algorithm (reference implementation). */
export function verify(
  secret: string,
  body: string,
  header: string,
  nowSeconds: number,
  toleranceSeconds = SIGNATURE_TOLERANCE_SECONDS,
): boolean {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=', 2) as [string, string]));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !parts.v1 || Math.abs(nowSeconds - t) > toleranceSeconds) return false;
  const expected = Buffer.from(sign(secret, body, t).split('v1=')[1]!, 'hex');
  const given = Buffer.from(parts.v1, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
