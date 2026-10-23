import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../test/app-factory.js';
import { headers, ownerWithOrg, type Owner } from '../../../test/auth-helpers.js';
import { sql } from '../../../test/db.js';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ env: { PLATFORM_EGRESS_IP: '204.168.197.27' } });
});

afterAll(async () => {
  await t?.close();
});

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const req = async (cookie: string, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: Json) => {
  const { 'content-type': _, ...noBody } = headers(cookie);
  const res = await t.app.inject({
    method,
    url,
    headers: payload === undefined ? noBody : headers(cookie),
    ...(payload === undefined ? {} : { payload }),
  });
  return { status: res.statusCode, json: (res.body ? res.json() : {}) as Json, body: res.body };
};

const managed = (owner: Owner, provider: string, config: Json) =>
  req(owner.cookie, 'POST', `/api/v1/organizations/${owner.orgId}/connections`, {
    provider,
    displayName: 'Supabase',
    executionLocation: 'cloud',
    config,
  });

const SUPABASE =
  'postgresql://postgres.abcd:sup3r%40secret@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?sslmode=require';

describe('managed databases (Atlas, Supabase)', () => {
  it('stores a connection string encrypted and keeps only host, port, and database in config', async () => {
    const owner = await ownerWithOrg(t);
    const created = await managed(owner, 'postgres', {
      host: 'aws-0-eu-central-1.pooler.supabase.com',
      port: 6543,
      database: 'postgres',
      tls: true,
    });
    expect(created.status, created.body).toBe(201);
    const id = created.json.id as string;
    const auth = await req(owner.cookie, 'POST', `/api/v1/connections/${id}/authorize`, {
      credentials: { connectionString: SUPABASE },
    });
    expect(auth.status, auth.body).toBe(200);
    expect(auth.json).toMatchObject({
      status: 'pending_validation',
      config: { host: 'aws-0-eu-central-1.pooler.supabase.com', port: 6543, database: 'postgres', tls: true },
    });
    expect(auth.body).not.toContain('sup3r');
    const [row] = await sql<{ config: string }>(`SELECT config::text FROM connections WHERE id = $1`, [id]);
    expect(row!.config).not.toContain('sup3r');
    const [secret] = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM connection_secrets WHERE connection_id = $1`,
      [id],
    );
    expect(secret!.n).toBe(1);
  });

  it('refuses a string for another engine, empty credentials, and plaintext', async () => {
    const owner = await ownerWithOrg(t);
    const id = (await managed(owner, 'postgres', { host: 'db.example.com', tls: true })).json.id as string;
    expect(
      (
        await req(owner.cookie, 'POST', `/api/v1/connections/${id}/authorize`, {
          credentials: { connectionString: 'mongodb+srv://u:p@c.mongodb.net/x' },
        })
      ).status,
    ).toBe(400);
    expect(
      (await req(owner.cookie, 'POST', `/api/v1/connections/${id}/authorize`, { credentials: {} })).status,
    ).toBe(400);
    expect(
      (
        await managed(owner, 'mongodb', {
          host: 'c.mongodb.net',
          database: 'x',
          tls: false,
          allowInsecure: true,
        })
      ).status,
    ).toBe(400);
  });

  it('shows the platform egress IP to allowlist (e.g. Atlas network access)', async () => {
    const owner = await ownerWithOrg(t);
    expect((await req(owner.cookie, 'GET', '/api/v1/connectors/catalog')).json.egressIp).toBe(
      '204.168.197.27',
    );
  });

  it('stops scheduled health checks when the connection is removed', async () => {
    const owner = await ownerWithOrg(t);
    const id = (await managed(owner, 'mongodb', { host: 'c.mongodb.net', database: 'x', tls: true })).json
      .id as string;
    await sql(
      `INSERT INTO job_definitions (id, organization_id, kind, entity_id, every_seconds) VALUES (gen_random_uuid(), $1, 'connection-health', $2, 300)`,
      [owner.orgId, id],
    );
    expect((await req(owner.cookie, 'DELETE', `/api/v1/connections/${id}`)).status).toBe(202);
    expect(await sql(`SELECT enabled FROM job_definitions WHERE entity_id = $1`, [id])).toEqual([
      { enabled: false },
    ]);
  });
});
