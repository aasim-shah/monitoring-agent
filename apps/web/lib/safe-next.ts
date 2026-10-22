const FALLBACK = '/orgs';

/**
 * Returns `next` only when it is a same-origin relative path; otherwise /orgs.
 * Blocks protocol-relative (//host), backslash tricks, schemes, control characters,
 * and their percent-encoded forms (open-redirect defense).
 */
export function safeNext(next: string | null | undefined): string {
  if (!next) return FALLBACK;
  let decoded: string;
  try {
    decoded = decodeURIComponent(next);
  } catch {
    return FALLBACK;
  }
  for (const value of [next, decoded]) {
    const hasControl = [...value].some((ch) => ch.charCodeAt(0) < 0x20);
    if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\') || hasControl)
      return FALLBACK;
  }
  return next;
}
