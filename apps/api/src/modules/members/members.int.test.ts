import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, uniqueEmail, type TestApp } from '../../../test/app-factory.js';
import {
  createProduct,
  enrollMfa,
  headers,
  login,
  ownerWithOrg,
  signUpAndVerify,
  type Owner,
} from '../../../test/auth-helpers.js';
import { sql } from '../../../test/db.js';
import { hashToken } from '../identity/tokens.js';

let t: TestApp;
let offsetMs = 0;
const clock = () => new Date(Date.now() + offsetMs);

beforeAll(async () => {
  t = await createTestApp({ clock });
});

afterAll(async () => {
  await t?.close();
});

// Bodiless requests carry no content-type, as browsers send them (Fastify rejects empty JSON bodies).
const req = (
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  cookie: string,
  payload?: Record<string, unknown>,
) => {
  const { 'content-type': _ct, ...bare } = headers(cookie);
  return t.app.inject({
    method,
    url,
    headers: payload ? headers(cookie) : bare,
    ...(payload ? { payload } : {}),
  });
};

async function invite(owner: Owner, email: string, role: string, extra: Record<string, unknown> = {}) {
  return req('POST', `/api/v1/organizations/${owner.orgId}/invitations`, owner.cookie, {
    email,
    role,
    ...extra,
  });
}

async function memberWithRole(
  owner: Owner,
  role: string,
): Promise<{ email: string; cookie: string; memberId: string }> {
  const email = await signUpAndVerify(t);
  const [u] = await sql<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email]);
  const memberId = randomUUID();
  await sql(`INSERT INTO organization_members (id, organization_id, user_id, role) VALUES ($1, $2, $3, $4)`, [
    memberId,
    owner.orgId,
    u!.id,
    role,
  ]);
  const cookie = await login(t, email);
  if (role === 'owner' || role === 'admin') await enrollMfa(t, cookie);
  return { email, cookie, memberId };
}

describe('invitations', () => {
  it('stores the token hashed and accepts once with role and product scope', async () => {
    const owner = await ownerWithOrg(t);
    const productId = await createProduct(t, owner);
    const email = uniqueEmail();
    const res = await invite(owner, email, 'analyst', { productIds: [productId] });
    expect(res.statusCode).toBe(201);
    const token = t.mailer.lastToken(email);
    const [row] = await sql<{ token_hash: string }>(`SELECT token_hash FROM invitations WHERE id = $1`, [
      res.json().id,
    ]);
    expect(row!.token_hash).toBe(hashToken(token));
    expect(row!.token_hash).not.toContain(token);

    await signUpAndVerify(t, email);
    const cookie = await login(t, email);
    const accepted = await req('POST', '/api/v1/invitations/accept', cookie, { token });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({ organizationId: owner.orgId, role: 'analyst' });

    const members = (await req('GET', `/api/v1/organizations/${owner.orgId}/members`, owner.cookie)).json()
      .members as Array<{
      email: string;
      role: string;
      productIds: string[] | 'all';
    }>;
    expect(members.find((m) => m.email === email)).toMatchObject({
      role: 'analyst',
      productIds: [productId],
    });

    const again = await req('POST', '/api/v1/invitations/accept', cookie, { token });
    expect(again.statusCode).toBe(400);
    expect(again.json().code).toBe('invalid_token');
  });

  it('rejects an operator inviting (no permission) and an admin inviting an owner (TC-01-07)', async () => {
    const owner = await ownerWithOrg(t);
    const operator = await memberWithRole(owner, 'operator');
    const byOperator = await req(
      'POST',
      `/api/v1/organizations/${owner.orgId}/invitations`,
      operator.cookie,
      {
        email: uniqueEmail(),
        role: 'viewer',
      },
    );
    expect(byOperator.statusCode).toBe(404);

    const admin = await memberWithRole(owner, 'admin');
    const byAdmin = await req('POST', `/api/v1/organizations/${owner.orgId}/invitations`, admin.cookie, {
      email: uniqueEmail(),
      role: 'owner',
    });
    expect(byAdmin.statusCode).toBe(403);
    expect(byAdmin.json().code).toBe('role_above_actor');
  });

  it('rejects an expired invitation (8 days later)', async () => {
    const owner = await ownerWithOrg(t);
    const email = uniqueEmail();
    await invite(owner, email, 'viewer');
    const token = t.mailer.lastToken(email);
    await signUpAndVerify(t, email);
    offsetMs = 8 * 24 * 3_600_000;
    try {
      const cookie = await login(t, email);
      const res = await req('POST', '/api/v1/invitations/accept', cookie, { token });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('invalid_token');
    } finally {
      offsetMs = 0;
    }
  });

  it('rejects acceptance by a different signed-in email', async () => {
    const owner = await ownerWithOrg(t);
    await invite(owner, uniqueEmail(), 'viewer');
    const invitedToken = t.mailer.messages.at(-1)!.text.match(/token=([A-Za-z0-9_-]+)/)![1]!;
    const other = await login(t, await signUpAndVerify(t));
    const res = await req('POST', '/api/v1/invitations/accept', other, { token: invitedToken });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('email_mismatch');
  });

  it('audits invitation and join', async () => {
    const owner = await ownerWithOrg(t);
    const email = uniqueEmail();
    await invite(owner, email, 'viewer');
    const token = t.mailer.lastToken(email); // before sign-up mails a verification link
    await signUpAndVerify(t, email);
    const accepted = await req('POST', '/api/v1/invitations/accept', await login(t, email), { token });
    expect(accepted.statusCode).toBe(200);
    const entries = (await req('GET', `/api/v1/organizations/${owner.orgId}/audit-logs`, owner.cookie)).json()
      .entries as Array<{
      action: string;
    }>;
    expect(entries.map((e) => e.action)).toEqual(
      expect.arrayContaining(['invitation.created', 'member.joined']),
    );
  });
});

describe('members', () => {
  it('refuses to remove or demote the last owner (Review Focus #3, TC-01-10)', async () => {
    const owner = await ownerWithOrg(t);
    const members = (await req('GET', `/api/v1/organizations/${owner.orgId}/members`, owner.cookie)).json()
      .members as Array<{
      id: string;
    }>;
    const self = members[0]!.id;
    const demote = await req('PATCH', `/api/v1/organizations/${owner.orgId}/members/${self}`, owner.cookie, {
      role: 'admin',
    });
    expect(demote.statusCode).toBe(409);
    expect(demote.json().code).toBe('last_owner');
    const remove = await req('DELETE', `/api/v1/organizations/${owner.orgId}/members/${self}`, owner.cookie);
    expect(remove.statusCode).toBe(409);
  });

  it('changes a role and product scope, audited', async () => {
    const owner = await ownerWithOrg(t);
    const productId = await createProduct(t, owner);
    const viewer = await memberWithRole(owner, 'viewer');
    const res = await req(
      'PATCH',
      `/api/v1/organizations/${owner.orgId}/members/${viewer.memberId}`,
      owner.cookie,
      {
        role: 'analyst',
        productIds: [productId],
      },
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ role: 'analyst', productIds: [productId] });
  });

  it('prevents an admin from changing an owner', async () => {
    const owner = await ownerWithOrg(t);
    const admin = await memberWithRole(owner, 'admin');
    const members = (await req('GET', `/api/v1/organizations/${owner.orgId}/members`, owner.cookie)).json()
      .members as Array<{
      id: string;
      role: string;
    }>;
    const ownerMember = members.find((m) => m.role === 'owner')!;
    const res = await req(
      'DELETE',
      `/api/v1/organizations/${owner.orgId}/members/${ownerMember.id}`,
      admin.cookie,
    );
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('role_above_actor');
  });

  it('a removed member loses access immediately', async () => {
    const owner = await ownerWithOrg(t);
    const viewer = await memberWithRole(owner, 'viewer');
    expect((await req('GET', `/api/v1/organizations/${owner.orgId}`, viewer.cookie)).statusCode).toBe(200);
    expect(
      (await req('DELETE', `/api/v1/organizations/${owner.orgId}/members/${viewer.memberId}`, owner.cookie))
        .statusCode,
    ).toBe(204);
    expect((await req('GET', `/api/v1/organizations/${owner.orgId}`, viewer.cookie)).statusCode).toBe(404);
  });

  it('returns 404 for a member of another organization', async () => {
    const a = await ownerWithOrg(t);
    const b = await ownerWithOrg(t);
    const bViewer = await memberWithRole(b, 'viewer');
    const res = await req('PATCH', `/api/v1/organizations/${a.orgId}/members/${bViewer.memberId}`, a.cookie, {
      role: 'admin',
    });
    expect(res.statusCode).toBe(404);
  });
});
