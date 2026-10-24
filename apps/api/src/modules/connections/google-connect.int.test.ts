import { createLocalJWKSet } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GOOGLE_DATA_SCOPES, SCOPE_PREFIX } from '@pcp/connectors-google';
import { APP_ORIGIN, createTestApp, type TestApp } from '../../../test/app-factory.js';
import { createProduct, headers, ownerWithOrg, type Owner } from '../../../test/auth-helpers.js';
import { sql } from '../../../test/db.js';

const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const CALLBACK = `${APP_ORIGIN}/api/v1/connections/oauth/google/callback`;
const REFRESH = 'google-refresh-token-1';

let t: TestApp;
/** What the fake token endpoint answers next, and what it was sent. */
let nextToken: Record<string, unknown> = {};
const exchanges: URLSearchParams[] = [];
const bodies: string[] = [];

const idToken = (email: string) =>
  [
    Buffer.from('{"alg":"RS256"}').toString('base64url'),
    Buffer.from(JSON.stringify({ email, email_verified: true, sub: '42' })).toString('base64url'),
    'sig',
  ].join('.');

beforeAll(async () => {
  t = await createTestApp({
    env: {
      GOOGLE_CLIENT_ID: CLIENT_ID,
      GOOGLE_CLIENT_SECRET: 'test-secret',
      GOOGLE_REDIRECT_URI: `${APP_ORIGIN}/api/v1/auth/google/callback`,
      GOOGLE_CONNECTIONS_REDIRECT_URI: CALLBACK,
    },
    google: {
      jwks: createLocalJWKSet({ keys: [] }),
      fetch: async (_url, init) => {
        exchanges.push(new URLSearchParams(String(init?.body)));
        return new Response(JSON.stringify(nextToken), {
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

async function call(method: 'GET' | 'POST', url: string, cookie: string, payload?: object) {
  const { 'content-type': _ct, ...bare } = headers(cookie);
  const res = await t.app.inject({
    method,
    url,
    headers: payload ? headers(cookie) : bare,
    ...(payload ? { payload } : {}),
  });
  bodies.push(res.body);
  return res;
}

async function googleConnection(owner: Owner) {
  const res = await call('POST', `/api/v1/organizations/${owner.orgId}/connections`, owner.cookie, {
    provider: 'google',
    displayName: 'Google',
    executionLocation: 'cloud',
    config: {},
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

async function start(owner: Owner, id: string, productId: string, missingOnly = false) {
  const res = await call('POST', `/api/v1/connections/${id}/oauth/google/start`, owner.cookie, {
    productId,
    missingOnly,
  });
  expect(res.statusCode, res.body).toBe(200);
  return new URL(res.json().url as string);
}

const callback = (cookie: string, query: Record<string, string>) =>
  call('GET', `/api/v1/connections/oauth/google/callback?${new URLSearchParams(query)}`, cookie);

const partial = GOOGLE_DATA_SCOPES.filter(
  (s) => !s.endsWith('/adwords') && !s.endsWith('/bigquery.readonly'),
);

describe('Google data connection OAuth (WB-08 UC-08-01/02, Review Focus #1/#3)', () => {
  it('TC-08-01: asks for every read scope with offline access, consent, and PKCE S256', async () => {
    const owner = await ownerWithOrg(t);
    const product = await createProduct(t, owner);
    const id = await googleConnection(owner);
    const url = await start(owner, id, product);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')!.split(' ').sort()).toEqual(
      [...GOOGLE_DATA_SCOPES, 'openid', 'email'].sort(),
    );
    expect(
      Object.fromEntries(
        [...url.searchParams].filter(([k]) => k !== 'scope' && k !== 'state' && k !== 'code_challenge'),
      ),
    ).toEqual({
      client_id: CLIENT_ID,
      redirect_uri: CALLBACK,
      response_type: 'code',
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      code_challenge_method: 'S256',
    });
  });

  it('TC-08-03: stores the refresh token and exactly the scopes Google granted, then validates', async () => {
    const owner = await ownerWithOrg(t);
    const product = await createProduct(t, owner);
    const id = await googleConnection(owner);
    const state = (await start(owner, id, product)).searchParams.get('state')!;
    nextToken = {
      access_token: 'at',
      refresh_token: REFRESH,
      scope: [...partial, 'openid', `${SCOPE_PREFIX}userinfo.email`].join(' '),
      id_token: idToken('ops@acme.example'),
    };
    const res = await callback(owner.cookie, { code: 'code-1', state });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(
      `${APP_ORIGIN}/orgs/${owner.orgId}/products/${product}/integrations/${id}?google=connected`,
    );
    const exchange = exchanges.at(-1)!;
    expect(exchange.get('grant_type')).toBe('authorization_code');
    expect(exchange.get('code')).toBe('code-1');
    expect(exchange.get('redirect_uri')).toBe(CALLBACK);
    expect(exchange.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    const [row] = await sql<{ status: string; granted_scopes: string[]; account_email: string }>(
      `SELECT status, granted_scopes, account_email FROM connections WHERE id = $1`,
      [id],
    );
    expect(row!.status).toBe('pending_validation');
    expect(row!.account_email).toBe('ops@acme.example');
    expect([...row!.granted_scopes].sort()).toEqual([...partial].sort());
    expect(await sql(`SELECT 1 FROM connection_secrets WHERE connection_id = $1`, [id])).toHaveLength(1);
    const view = await call('GET', `/api/v1/connections/${id}`, owner.cookie);
    expect(view.json()).toMatchObject({ accountEmail: 'ops@acme.example' });
    expect([...view.json().grantedScopes].sort()).toEqual([...partial].sort());
  });

  it('TC-08-04: "Grant access" asks only for the missing scopes and keeps the stored refresh token', async () => {
    const owner = await ownerWithOrg(t);
    const product = await createProduct(t, owner);
    const id = await googleConnection(owner);
    const first = (await start(owner, id, product)).searchParams.get('state')!;
    nextToken = { refresh_token: REFRESH, scope: partial.join(' '), id_token: idToken('ops@acme.example') };
    await callback(owner.cookie, { code: 'c1', state: first });
    const [before] = await sql<{ ciphertext: unknown }>(
      `SELECT ciphertext FROM connection_secrets WHERE connection_id = $1`,
      [id],
    );

    const again = await start(owner, id, product, true);
    expect(again.searchParams.get('scope')!.split(' ').sort()).toEqual(
      [`${SCOPE_PREFIX}adwords`, `${SCOPE_PREFIX}bigquery.readonly`, 'openid', 'email'].sort(),
    );
    expect(again.searchParams.get('include_granted_scopes')).toBe('true');
    // Google often omits the refresh token on a repeat grant; the stored one stays.
    nextToken = { scope: GOOGLE_DATA_SCOPES.join(' '), id_token: idToken('ops@acme.example') };
    const res = await callback(owner.cookie, { code: 'c2', state: again.searchParams.get('state')! });
    expect(res.statusCode).toBe(302);
    const [after] = await sql<{ ciphertext: unknown }>(
      `SELECT ciphertext FROM connection_secrets WHERE connection_id = $1`,
      [id],
    );
    expect(after!.ciphertext).toEqual(before!.ciphertext);
    const [row] = await sql<{ granted_scopes: string[] }>(
      `SELECT granted_scopes FROM connections WHERE id = $1`,
      [id],
    );
    expect([...row!.granted_scopes].sort()).toEqual([...GOOGLE_DATA_SCOPES].sort());
  });

  it('TC-08-02: an unknown, reused, or another member’s state is refused and stores nothing', async () => {
    const owner = await ownerWithOrg(t);
    const other = await ownerWithOrg(t);
    const product = await createProduct(t, owner);
    const id = await googleConnection(owner);
    nextToken = { refresh_token: REFRESH, scope: partial.join(' '), id_token: idToken('x@acme.example') };
    expect((await callback(owner.cookie, { code: 'c', state: 'not-a-real-state-value' })).json().code).toBe(
      'invalid_state',
    );
    const stolen = (await start(owner, id, product)).searchParams.get('state')!;
    expect((await callback(other.cookie, { code: 'c', state: stolen })).statusCode).toBe(400);
    // The state is spent even by a refused attempt.
    expect((await callback(owner.cookie, { code: 'c', state: stolen })).statusCode).toBe(400);
    expect(await sql(`SELECT 1 FROM connection_secrets WHERE connection_id = $1`, [id])).toEqual([]);
  });

  it('a cancelled consent returns to the connection page and stores nothing', async () => {
    const owner = await ownerWithOrg(t);
    const product = await createProduct(t, owner);
    const id = await googleConnection(owner);
    const state = (await start(owner, id, product)).searchParams.get('state')!;
    const res = await callback(owner.cookie, { error: 'access_denied', state });
    expect(res.headers.location).toBe(
      `${APP_ORIGIN}/orgs/${owner.orgId}/products/${product}/integrations/${id}?google=cancelled`,
    );
    expect(await sql(`SELECT 1 FROM connection_secrets WHERE connection_id = $1`, [id])).toEqual([]);
  });

  it('refuses pasted credentials for Google: only the OAuth flow stores them', async () => {
    const owner = await ownerWithOrg(t);
    const id = await googleConnection(owner);
    const res = await call('POST', `/api/v1/connections/${id}/authorize`, owner.cookie, { credentials: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('oauth_required');
  });

  it('never returns the refresh token', () => {
    for (const b of bodies) expect(b).not.toContain(REFRESH);
  });
});
