import { describe, expect, it } from 'vitest';
import { securityHeaders } from './security-headers.mjs';

const get = (headers: Array<{ key: string; value: string }>, key: string) =>
  headers.find((h) => h.key === key)?.value;

describe('security headers (M19.1)', () => {
  it('sends a CSP that allows only this origin and forbids framing, plugins, and foreign forms', () => {
    const csp = get(securityHeaders(true), 'Content-Security-Policy')!;
    const directives = Object.fromEntries(
      csp.split(';').map((d) => {
        const [name, ...values] = d.trim().split(/\s+/);
        return [name, values.join(' ')];
      }),
    );
    expect(directives).toMatchObject({
      'default-src': "'self'",
      'connect-src': "'self'",
      'frame-ancestors': "'none'",
      'object-src': "'none'",
      'base-uri': "'self'",
      'form-action': "'self'",
    });
    expect(directives['script-src']).not.toContain("'unsafe-eval'");
    expect(directives['script-src']).not.toContain('*');
  });

  it('sends referrer, permissions, and content-type policies', () => {
    const h = securityHeaders(true);
    expect(get(h, 'Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(get(h, 'Permissions-Policy')).toBe('camera=(), microphone=(), geolocation=(), payment=()');
    expect(get(h, 'X-Content-Type-Options')).toBe('nosniff');
    expect(get(h, 'X-Frame-Options')).toBe('DENY');
  });

  it('allows eval only in development (React refresh needs it)', () => {
    expect(get(securityHeaders(false), 'Content-Security-Policy')).toContain("'unsafe-eval'");
  });
});
