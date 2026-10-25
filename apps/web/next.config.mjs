import { fileURLToPath } from 'node:url';
import { securityHeaders } from './lib/security-headers.mjs';

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // Trace dependencies from the monorepo root so the standalone server includes workspace packages.
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders(process.env.NODE_ENV === 'production') }];
  },
  // In Compose, Caddy routes /api to the API. For `next dev`, set API_INTERNAL_URL (e.g. http://localhost:3000).
  async rewrites() {
    const api =
      process.env.API_INTERNAL_URL ??
      (process.env.NODE_ENV === 'development' ? 'http://127.0.0.1:3000' : undefined);
    return api ? [{ source: '/api/:path*', destination: `${api}/api/:path*` }] : [];
  },
};

export default nextConfig;
