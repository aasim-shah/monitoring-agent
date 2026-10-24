import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { SignJWT, exportJWK, generateKeyPair, type KeyLike } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  APP_ORIGIN,
  createTestApp,
  sessionCookie,
  uniqueEmail,
  type TestApp,
} from '../../../test/app-factory.js';
import { headers } from '../../../test/auth-helpers.js';

// A stand-in OpenID Provider (Keycloak, Authentik, Entra ID, Okta …): discovery, token, JWKS.
let issuer = '';
let privateKey: KeyLike;
let jwk: Record<string, unknown> = {};
let nextClaims: Record<string, unknown> = {};
let tokenRequests: URLSearchParams[] = [];
const op: Server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', issuer);
  res.setHeader('content-type', 'application/json');
  if (url.pathname === '/.well-known/openid-configuration')
    return res.end(
      JSON.stringify({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
      }),
    );
  if (url.pathname === '/jwks') return res.end(JSON.stringify({ keys: [jwk] }));
  if (url.pathname === '/token') {
    let body = '';
    for await (const chunk of req) body += chunk;
    tokenRequests.push(new URLSearchParams(body));
    const idToken = await new SignJWT(nextClaims)
      .setProtectedHeader({ alg: 'RS256', kid: 'op' })
      .setIssuer(issuer)
      .setAudience('pcp')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    return res.end(JSON.stringify({ id_token: idToken, access_token: 'x', token_type: 'Bearer' }));
  }
  res.statusCode = 404;
  res.end('{}');
});

let t: TestApp;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  jwk = { ...(await exportJWK(pair.publicKey)), kid: 'op', alg: 'RS256', use: 'sig' };
  issuer = await new Promise<string>((r) =>
    op.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(op.address() as { port: number }).port}`)),
  );
  t = await createTestApp({
    env: {
      OIDC_ISSUER: issuer,
      OIDC_CLIENT_ID: 'pcp',
      OIDC_CLIENT_SECRET: 'oidc-secret',
      OIDC_REDIRECT_URI: `${APP_ORIGIN}/api/v1/auth/oidc/callback`,
      OIDC_DISPLAY_NAME: 'Acme SSO',
    },
  });
});

afterAll(async () => {
  await t?.close();
  await new Promise((r) => op.close(r));
});

async function start() {
  const res = await t.app.inject({ method: 'GET', url: '/api/v1/auth/oidc/start' });
  expect(res.statusCode, res.body).toBe(302);
  const location = new URL(String(res.headers.location));
  const stateCookie = ([] as string[])
    .concat(res.headers['set-cookie'] as string[])
    .find((c) => c.startsWith('pcp_oauth_state='))!
    .split(';')[0]!;
  return { location, stateCookie };
}

const callback = (location: URL, stateCookie: string) =>
  t.app.inject({
    method: 'GET',
    url: `/api/v1/auth/oidc/callback?code=abc&state=${location.searchParams.get('state')}`,
    headers: { cookie: stateCookie },
  });

describe('OIDC sign-in for self-hosted deployments (M19.4)', () => {
  it('advertises the configured sign-in methods', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/auth/providers' });
    expect(res.json()).toEqual({
      google: false,
      oidc: { name: 'Acme SSO', startUrl: '/api/v1/auth/oidc/start' },
    });
  });

  it('redirects to the discovered authorization endpoint with PKCE, then signs a verified user in', async () => {
    const { location, stateCookie } = await start();
    expect(location.origin + location.pathname).toBe(`${issuer}/authorize`);
    expect(location.searchParams.get('scope')).toBe('openid email profile');
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    const email = uniqueEmail();
    nextClaims = {
      sub: randomUUID(),
      email,
      email_verified: true,
      nonce: location.searchParams.get('nonce'),
    };
    tokenRequests = [];
    const res = await callback(location, stateCookie);
    expect(res.statusCode, res.body).toBe(302);
    expect(res.headers.location).toBe(`${APP_ORIGIN}/`);
    expect(tokenRequests[0]!.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const me = await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: headers(sessionCookie(res)) });
    expect(me.json().user).toMatchObject({ email });
    // The same subject signs in again to the same account.
    const again = await start();
    nextClaims = { ...nextClaims, nonce: again.location.searchParams.get('nonce') };
    const second = await callback(again.location, again.stateCookie);
    const me2 = await t.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: headers(sessionCookie(second)),
    });
    expect(me2.json().user.id).toBe(me.json().user.id);
  });

  it('refuses an unverified email, a wrong nonce, and a mismatched state', async () => {
    let { location, stateCookie } = await start();
    nextClaims = {
      sub: randomUUID(),
      email: uniqueEmail(),
      email_verified: false,
      nonce: location.searchParams.get('nonce'),
    };
    expect((await callback(location, stateCookie)).json().code).toBe('oidc_email_unverified');
    ({ location, stateCookie } = await start());
    nextClaims = { sub: randomUUID(), email: uniqueEmail(), email_verified: true, nonce: 'other' };
    expect((await callback(location, stateCookie)).json().code).toBe('invalid_id_token');
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/v1/auth/oidc/callback?code=abc&state=${'x'.repeat(43)}`,
      headers: { cookie: (await start()).stateCookie },
    });
    expect(res.json().code).toBe('invalid_state');
  });
});

describe('without OIDC', () => {
  it('reports no providers and refuses the routes', async () => {
    const plain = await createTestApp();
    try {
      expect((await plain.app.inject({ method: 'GET', url: '/api/v1/auth/providers' })).json()).toEqual({
        google: false,
        oidc: null,
      });
      expect((await plain.app.inject({ method: 'GET', url: '/api/v1/auth/oidc/start' })).statusCode).toBe(
        404,
      );
    } finally {
      await plain.close();
    }
  });
});
