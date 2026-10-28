import { generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SCOPE_PREFIX, SERVICE_ACCOUNT_SCOPES } from '@pcp/connectors-google';
import { APP_ORIGIN, createTestApp, type TestApp } from '../../../test/app-factory.js';
import { headers, ownerWithOrg, type Owner } from '../../../test/auth-helpers.js';
import { sql } from '../../../test/db.js';

const EMAIL = 'pcp-reader@acme-prod.iam.gserviceaccount.com';
const pem = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();
const keyFile = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'service_account',
    project_id: 'acme-prod',
    private_key: pem,
    client_email: EMAIL,
    ...over,
  });

let t: TestApp;
let google: Server;
/** Hosts the fake Google answers 403 on: the services the service account was not added to. */
let deniedHosts: string[] = [];
let tokenStatus = 200;
const tokenGrants: string[] = [];
const bodies: string[] = [];

beforeAll(async () => {
  google = createServer((req, res) => {
    const [, host, ...rest] = (req.url ?? '/').split('/');
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (host === 'oauth2.googleapis.com') {
        tokenGrants.push(new URLSearchParams(body).get('grant_type') ?? '');
        res.statusCode = tokenStatus;
        res.end(JSON.stringify(tokenStatus === 200 ? { access_token: 'at-sa' } : { error: 'invalid_grant' }));
        return;
      }
      if (deniedHosts.includes(host!)) {
        res.statusCode = 403;
        res.end(JSON.stringify({ error: { message: `no access to ${rest[0]}` } }));
        return;
      }
      res.end('{}');
    });
  });
  await new Promise<void>((r) => google.listen(0, '127.0.0.1', r));
  const { port } = google.address() as AddressInfo;
  t = await createTestApp({
    env: {
      GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'test-secret',
      GOOGLE_REDIRECT_URI: `${APP_ORIGIN}/api/v1/auth/google/callback`,
      GOOGLE_CONNECTIONS_REDIRECT_URI: `${APP_ORIGIN}/api/v1/connections/oauth/google/callback`,
      PCP_ALLOW_TEST_PROVIDERS: '1',
      PCP_GOOGLE_API_URL: `http://127.0.0.1:${port}`,
    },
  });
});

afterAll(async () => {
  await t?.close();
  await new Promise((r) => google?.close(r));
});

async function call(method: 'POST', url: string, cookie: string, payload?: object) {
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

const upload = (owner: Owner, id: string, key: string) =>
  call('POST', `/api/v1/connections/${id}/google/service-account`, owner.cookie, { key });

const stored = async (id: string) =>
  (
    await sql<{ status: string; account_email: string | null; granted_scopes: string[] }>(
      `SELECT status, account_email, granted_scopes FROM connections WHERE id = $1`,
      [id],
    )
  )[0]!;

describe('Google service account keys (connect without Google sign-in)', () => {
  it('stores the key, names the account, and grants only the services the account can read', async () => {
    deniedHosts = ['www.googleapis.com', 'playdeveloperreporting.googleapis.com'];
    const owner = await ownerWithOrg(t);
    const id = await googleConnection(owner);
    const res = await upload(owner, id, keyFile());
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      accountEmail: EMAIL,
      services: ['ga4', 'firebase'],
      denied: ['Search Console: no access to webmasters', 'Play vitals: no access to v1beta1'],
    });
    expect(tokenGrants.at(-1)).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const row = await stored(id);
    expect(row.status).toBe('pending_validation');
    expect(row.account_email).toBe(EMAIL);
    expect(row.granted_scopes).toContain(`${SCOPE_PREFIX}analytics.readonly`);
    expect(row.granted_scopes).toContain(`${SCOPE_PREFIX}firebase.readonly`);
    expect(row.granted_scopes).not.toContain(`${SCOPE_PREFIX}webmasters.readonly`);
    expect(row.granted_scopes).not.toContain(`${SCOPE_PREFIX}playdeveloperreporting`);
    expect(row.granted_scopes).not.toContain(`${SCOPE_PREFIX}adwords`);

    // The customer adds the email in Search Console and Play Console, then checks again.
    deniedHosts = [];
    const again = await call('POST', `/api/v1/connections/${id}/google/service-account/check`, owner.cookie);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().services).toEqual(['ga4', 'searchConsole', 'firebase', 'play']);
    expect((await stored(id)).granted_scopes.sort()).toEqual([...SERVICE_ACCOUNT_SCOPES].sort());
  });

  it('refuses a file that is not a service account key and stores nothing', async () => {
    const owner = await ownerWithOrg(t);
    const id = await googleConnection(owner);
    for (const [key, message] of [
      ['{"type":"authorized_user"}', /not a service account key/],
      ['not json', /not JSON/],
      [keyFile({ private_key: 'broken' }), /private_key/],
    ] as const) {
      const res = await upload(owner, id, key);
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('invalid_service_account_key');
      expect(res.json().message).toMatch(message);
    }
    expect((await stored(id)).account_email).toBeNull();
  });

  it('a key Google refuses is reported to the member as needing a new key', async () => {
    tokenStatus = 400;
    try {
      const owner = await ownerWithOrg(t);
      const id = await googleConnection(owner);
      const res = await upload(owner, id, keyFile());
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('reauthorization_required');
      expect(res.json().message).toMatch(/upload a new key/);
    } finally {
      tokenStatus = 200;
    }
  });

  it('checking access needs a service account connection', async () => {
    const owner = await ownerWithOrg(t);
    const id = await googleConnection(owner);
    const res = await call('POST', `/api/v1/connections/${id}/google/service-account/check`, owner.cookie);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('not_service_account');
  });

  it('never returns the private key', () => {
    for (const b of bodies) expect(b).not.toContain('PRIVATE KEY');
  });
});
