/**
 * Browser security headers for every page (M19.1). The app talks only to its own origin: the API is
 * same-origin behind Caddy, SSE live tail too, and Google sign-in is a top-level link, not a form.
 * Next.js needs inline scripts for hydration and inline styles for charts; eval only in development.
 * @param {boolean} production
 * @returns {Array<{ key: string, value: string }>}
 */
export function securityHeaders(production) {
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${production ? '' : " 'unsafe-eval'"}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
  return [
    { key: 'Content-Security-Policy', value: csp },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'X-Frame-Options', value: 'DENY' },
  ];
}
