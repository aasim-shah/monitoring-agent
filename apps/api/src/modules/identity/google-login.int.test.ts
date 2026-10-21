import { randomUUID } from 'node:crypto';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  APP_ORIGIN,
  createTestApp,
  sessionCookie,
  uniqueEmail,
  type TestApp,
} from '../../../test/app-factory.js';
import { headers } from '../../../test/auth-helpers.js';

const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const googleEnv = {
  GOOGLE_CLIENT_ID: CLIENT_ID,
  GOOGLE_CLIENT_SECRET: 'test-secret',
  GOOGLE_REDIRECT_URI: `${APP_ORIGIN}/api/v1/auth/google/callback`,
};

let t: TestApp;
let privateKey: KeyLike;
let nextClaims: Record<string, unknown> = {};

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'test', alg: 'RS256', use: 'sig' };
  t = await createTestApp({
    env: googleEnv,
    google: {
      jwks: createLocalJWKSet({ keys: [jwk] }),
      fetch: async () => {
        const idToken = await new SignJWT(nextClaims)
          .setProtectedHeader({ alg: 'RS256', kid: 'test' })
          .setIssuer('https://accounts.google.com')
          .setAudience(CLIENT_ID)
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(privateKey);
        return new Response(JSON.stringify({ id_token: idToken, access_token: 'x' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    },
  });
});

afterAll(async () => {
  await t?.close();
});

async function start() {
  const res = await t.app.inject({ method: 'GET', url: '/api/v1/auth/google/start' });
  expect(res.statusCode).toBe(302);
  const location = new URL(String(res.headers.location));
  const stateCookie = ([] as string[])
    .concat(res.headers['set-cookie'] as string[])
    .find((c) => c.startsWith('pcp_oauth_state='))!
    .split(';')[0]!;
  return { location, stateCookie };
}

describe('Google login', () => {
  it('requests only openid email profile, with PKCE S256 and state', async () => {
    const { location } = await start();
    expect(location.origin + location.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(location.searchParams.get('scope')).toBe('openid email profile');
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(location.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(location.searchParams.get('client_id')).toBe(CLIENT_ID);
  });

  it('rejects a callback whose state does not match', async () => {
    const { stateCookie } = await start();
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/v1/auth/google/callback?code=abc&state=${'x'.repeat(43)}`,
      headers: { cookie: stateCookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('invalid_state');
  });

  it('rejects an unverified Google email', async () => {
    const { location, stateCookie } = await start();
    nextClaims = {
      sub: randomUUID(),
      email: uniqueEmail(),
      email_verified: false,
      nonce: location.searchParams.get('nonce'),
    };
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/v1/auth/google/callback?code=abc&state=${location.searchParams.get('state')}`,
      headers: { cookie: stateCookie },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('google_email_unverified');
  });

  it('creates a verified user and a session for a valid ID token', async () => {
    const { location, stateCookie } = await start();
    const email = uniqueEmail();
    nextClaims = {
      sub: randomUUID(),
      email,
      email_verified: true,
      nonce: location.searchParams.get('nonce'),
    };
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/v1/auth/google/callback?code=abc&state=${location.searchParams.get('state')}`,
      headers: { cookie: stateCookie },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${APP_ORIGIN}/`);
    const me = await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: headers(sessionCookie(res)) });
    expect(me.json().user.email).toBe(email);
    const user = await t.prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.emailVerifiedAt).not.toBeNull();
  });

  it('reports not configured when Google credentials are absent', async () => {
    const plain = await createTestApp();
    try {
      const res = await plain.app.inject({ method: 'GET', url: '/api/v1/auth/google/start' });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('google_login_not_configured');
    } finally {
      await plain.close();
    }
  });
});
