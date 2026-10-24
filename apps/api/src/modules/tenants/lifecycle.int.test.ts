import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../test/app-factory.js';
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

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t?.close();
});

const call = (method: 'GET' | 'POST' | 'DELETE', url: string, cookie: string, payload?: object) => {
  const { 'content-type': _ct, ...bare } = headers(cookie);
  return t.app.inject({
    method,
    url,
    headers: payload ? headers(cookie) : bare,
    ...(payload ? { payload } : {}),
  });
};

async function member(owner: Owner, role: string) {
  const email = await signUpAndVerify(t);
  const [u] = await sql<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email]);
  await sql(`INSERT INTO organization_members (id, organization_id, user_id, role) VALUES ($1, $2, $3, $4)`, [
    randomUUID(),
    owner.orgId,
    u!.id,
    role,
  ]);
  const cookie = await login(t, email);
  if (role === 'admin') await enrollMfa(t, cookie);
  return cookie;
}

/** An organization with an agent and a connection holding a stored secret. */
async function busyOrg(name: string) {
  const owner = await ownerWithOrg(t, name);
  const product = await createProduct(t, owner);
  const [env] = await sql<{ id: string }>(
    `INSERT INTO environments (id, organization_id, product_id, name) VALUES ($1, $2, $3, 'production') RETURNING id`,
    [randomUUID(), owner.orgId, product],
  );
  const enrollment = randomUUID();
  await sql(
    `INSERT INTO agent_enrollments (id, organization_id, product_id, environment_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + interval '1 hour')`,
    [enrollment, owner.orgId, product, env!.id, randomUUID()],
  );
  const agent = randomUUID();
  await sql(
    `INSERT INTO agents (id, organization_id, product_id, environment_id, enrollment_id, agent_type, hostname, machine_id, os, arch, agent_version)
     VALUES ($1, $2, $3, $4, $5, 'host', 'web-1', $6, 'linux', 'amd64', '0.3.0')`,
    [agent, owner.orgId, product, env!.id, enrollment, randomUUID()],
  );
  const conn = randomUUID();
  await sql(
    `INSERT INTO connections (id, organization_id, provider, display_name, status, execution_location, updated_at)
     VALUES ($1, $2, 'github', 'GitHub', 'connected', 'cloud', now())`,
    [conn, owner.orgId],
  );
  await sql(
    `INSERT INTO connection_secrets (connection_id, organization_id, ciphertext, key_version) VALUES ($1, $2, 'x', 1)`,
    [conn, owner.orgId],
  );
  return { owner, product, agent, conn };
}

describe('organization deletion (WB-17 UC-17-09)', () => {
  it('needs the typed name, then revokes agents, disconnects connections, and hides the organization from members', async () => {
    const { owner, agent, conn } = await busyOrg('Leaving Co');
    const analyst = await member(owner, 'analyst');
    const url = `/api/v1/organizations/${owner.orgId}`;
    expect((await call('DELETE', url, owner.cookie, { confirmName: 'leaving co' })).json().code).toBe(
      'confirmation_mismatch',
    );
    const res = await call('DELETE', url, owner.cookie, { confirmName: 'Leaving Co' });
    expect(res.statusCode, res.body).toBe(202);
    const scheduled = new Date(res.json().deletionScheduledFor).getTime();
    expect(scheduled - Date.now()).toBeGreaterThan(29.9 * 86_400_000);

    expect((await sql(`SELECT status FROM agents WHERE id = $1`, [agent]))[0]!.status).toBe('revoked');
    expect((await sql(`SELECT status FROM connections WHERE id = $1`, [conn]))[0]!.status).toBe(
      'disconnected',
    );
    expect(await sql(`SELECT 1 FROM connection_secrets WHERE connection_id = $1`, [conn])).toEqual([]);
    expect((await call('GET', `/api/v1/organizations/${owner.orgId}`, analyst)).statusCode).toBe(404);
    const view = await call('GET', `/api/v1/organizations/${owner.orgId}`, owner.cookie);
    expect(view.json()).toMatchObject({ deletionScheduledFor: res.json().deletionScheduledFor });
    expect(
      await sql(
        `SELECT action FROM audit_logs WHERE organization_id = $1 AND action = 'organization.deletion_requested'`,
        [owner.orgId],
      ),
    ).toHaveLength(1);
  });

  it('only the owner may request it; an admin gets 404', async () => {
    const { owner } = await busyOrg('Guarded Co');
    const admin = await member(owner, 'admin');
    const res = await call('DELETE', `/api/v1/organizations/${owner.orgId}`, admin, {
      confirmName: 'Guarded Co',
    });
    expect(res.statusCode).toBe(404);
    expect(
      (await sql(`SELECT deletion_requested_at FROM organizations WHERE id = $1`, [owner.orgId]))[0]!
        .deletion_requested_at,
    ).toBeNull();
  });

  it('cancelling during the grace period restores access for members', async () => {
    const { owner } = await busyOrg('Back Co');
    const analyst = await member(owner, 'analyst');
    const url = `/api/v1/organizations/${owner.orgId}`;
    await call('DELETE', url, owner.cookie, { confirmName: 'Back Co' });
    expect((await call('GET', `/api/v1/organizations/${owner.orgId}`, analyst)).statusCode).toBe(404);
    const res = await call('POST', `/api/v1/organizations/${owner.orgId}/deletion/cancel`, owner.cookie, {});
    expect(res.statusCode, res.body).toBe(204);
    expect((await call('GET', `/api/v1/organizations/${owner.orgId}`, analyst)).statusCode).toBe(200);
  });
});

describe('organization export (WB-17 UC-17-09)', () => {
  it('queues one export, lists it, and serves the archive only while its link is valid', async () => {
    const owner = await ownerWithOrg(t, 'Export Co');
    const url = `/api/v1/organizations/${owner.orgId}/export`;
    const created = await call('POST', url, owner.cookie, {});
    expect(created.statusCode, created.body).toBe(202);
    const { id } = created.json() as { id: string };
    expect(created.json()).toMatchObject({ status: 'queued' });
    // Asking again while one is queued returns the same export.
    expect((await call('POST', url, owner.cookie, {})).json().id).toBe(id);
    expect((await call('GET', url, owner.cookie)).json().exports).toEqual([
      expect.objectContaining({ id, status: 'queued' }),
    ]);
    const download = `${url}/${id}/download`;
    expect((await call('GET', download, owner.cookie)).statusCode).toBe(409);

    // The worker finished it.
    const archive = gzipSync(JSON.stringify({ organization: { name: 'Export Co' } }));
    await sql(
      `UPDATE tenant_exports SET status = 'ready', archive = $2, size_bytes = $3, expires_at = now() + interval '1 hour' WHERE id = $1`,
      [id, archive, archive.length],
    );
    const res = await call('GET', download, owner.cookie);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/gzip');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="pcp-export-.*\.json\.gz"/);
    expect(res.rawPayload.equals(archive)).toBe(true);

    await sql(`UPDATE tenant_exports SET expires_at = now() - interval '1 minute' WHERE id = $1`, [id]);
    expect((await call('GET', download, owner.cookie)).statusCode).toBe(410);
  });

  it('is for owners only', async () => {
    const owner = await ownerWithOrg(t, 'Private Co');
    const admin = await member(owner, 'admin');
    expect((await call('POST', `/api/v1/organizations/${owner.orgId}/export`, admin, {})).statusCode).toBe(
      404,
    );
  });
});
