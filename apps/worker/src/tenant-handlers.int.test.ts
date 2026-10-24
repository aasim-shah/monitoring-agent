import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, TENANT_TABLES, type PrismaClient } from '@pcp/database';
import type { TenantContext } from '@pcp/shared-contracts';
import { createServer, type Server } from 'node:http';
import { startPostgres, TEST_PASSWORDS, type TestDatabase } from '@pcp/test-support';
import { purgeDueTenants, tenantHandlers } from './tenant-handlers.js';

let db: TestDatabase;
let prisma: PrismaClient;
let scheduler: PrismaClient;
let vm: Server;
let vmPort = 0;
const vmCalls: string[] = [];

async function sql(text: string, values: unknown[] = []) {
  const c = new pg.Client({ connectionString: db.superuserUrl });
  await c.connect();
  try {
    return (await c.query(text, values)).rows;
  } finally {
    await c.end();
  }
}

const ctx = (organizationId: string): TenantContext => ({
  organizationId,
  actor: { kind: 'system', jobId: 'test' },
  roles: ['owner'],
  productIds: 'all',
  environmentIds: 'all',
  requestId: 'r',
});

const SECRETS = [
  'cipher-SECRET-1',
  'hooks.slack.com/services/SECRET-2',
  'invite-hash-SECRET-3',
  'sealed-SECRET-4',
];

async function seedOrg(name: string) {
  const [org, user, product, conn, channel, exportId] = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ];
  await sql(`INSERT INTO organizations (id, name) VALUES ($1, $2)`, [org, name]);
  await sql(`INSERT INTO users (id, email) VALUES ($1, $2)`, [user, `${user}@example.com`]);
  await sql(
    `INSERT INTO organization_members (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'owner')`,
    [randomUUID(), org, user],
  );
  await sql(`INSERT INTO products (id, organization_id, name) VALUES ($1, $2, 'Shop')`, [product, org]);
  await sql(
    `INSERT INTO connections (id, organization_id, provider, display_name, status, execution_location, config, updated_at)
     VALUES ($1, $2, 'github', 'GitHub', 'connected', 'cloud', '{"owner":"acme"}', now())`,
    [conn, org],
  );
  await sql(
    `INSERT INTO connection_secrets (connection_id, organization_id, ciphertext, key_version) VALUES ($1, $2, $3, 1)`,
    [conn, org, SECRETS[0]],
  );
  await sql(
    `INSERT INTO notification_channels (id, organization_id, name, kind, config, secret, updated_at)
     VALUES ($1, $2, 'Ops Slack', 'slack', '{"host":"hooks.slack.com"}', $3, now())`,
    [channel, org, SECRETS[1]],
  );
  await sql(
    `INSERT INTO invitations (id, organization_id, email, role, token_hash, expires_at, invited_by_user_id)
     VALUES ($1, $2, 'new@example.com', 'viewer', $3, now() + interval '1 day', $4)`,
    [randomUUID(), org, `${SECRETS[2]}-${name}`, user],
  );
  await sql(
    `INSERT INTO tenant_exports (id, organization_id, requested_by_user_id, status) VALUES ($1, $2, $3, 'queued')`,
    [exportId, org, user],
  );
  return { org, user, product, exportId };
}

beforeAll(async () => {
  db = await startPostgres();
  prisma = createPrismaClient(db.appUrl);
  const u = new URL(db.superuserUrl);
  u.username = 'pcp_scheduler';
  u.password = TEST_PASSWORDS.scheduler;
  scheduler = createPrismaClient(u.toString());
  vm = createServer((req, res) => {
    vmCalls.push(`${req.method} ${decodeURIComponent(req.url ?? '')}`);
    res.writeHead(204).end();
  });
  vmPort = await new Promise<number>((r) =>
    vm.listen(0, '127.0.0.1', () => r((vm.address() as { port: number }).port)),
  );
}, 180_000);

afterAll(async () => {
  await Promise.all([prisma?.$disconnect(), scheduler?.$disconnect()]);
  await new Promise((r) => vm?.close(r));
  await db?.stop();
});

describe('tenant export (WB-17 UC-17-09)', () => {
  it('builds a gzip JSON archive of the organization without any secret, valid for 24 h', async () => {
    const a = await seedOrg('Acme');
    await seedOrg('Other');
    const now = new Date('2026-10-25T10:00:00Z');
    const h = tenantHandlers({ prisma, now: () => now });
    await h['tenant-export'](ctx(a.org), a.exportId);
    const [row] = await sql(
      `SELECT status, archive, size_bytes, expires_at FROM tenant_exports WHERE id = $1`,
      [a.exportId],
    );
    expect(row!.status).toBe('ready');
    expect((row!.expires_at as Date).toISOString()).toBe('2026-10-26T10:00:00.000Z');
    const text = gunzipSync(row!.archive as Buffer).toString('utf8');
    expect(row!.size_bytes).toBe((row!.archive as Buffer).length);
    const archive = JSON.parse(text) as { organization: { name: string }; tables: Record<string, unknown[]> };
    expect(archive.organization.name).toBe('Acme');
    expect(archive.tables.products).toHaveLength(1);
    expect(archive.tables.connections).toEqual([
      expect.objectContaining({ display_name: 'GitHub', config: { owner: 'acme' } }),
    ]);
    expect(archive.tables.notification_channels).toEqual([
      expect.not.objectContaining({ secret: expect.anything() }),
    ]);
    expect(archive.tables.members).toEqual([
      expect.objectContaining({ email: `${a.user}@example.com`, role: 'owner' }),
    ]);
    for (const secret of SECRETS) expect(text).not.toContain(secret);
    expect(text).not.toContain('Other');
    expect(archive.tables.connection_secrets).toBeUndefined();
  });
});

/** Rows mentioning the organization in any tenant table (organizations by id, the rest by organization_id). */
async function remaining(org: string) {
  const left: Record<string, number> = {};
  for (const table of TENANT_TABLES) {
    const col = table === 'organizations' ? 'id' : 'organization_id';
    const [r] = await sql(`SELECT count(*)::int AS n FROM ${table} WHERE ${col} = $1`, [org]);
    if (r!.n) left[table] = r!.n;
  }
  return left;
}

describe('tenant purge after the grace period (WB-17 UC-17-09, TC-17-06)', () => {
  it('removes every tenant row and telemetry series, keeps a summary, and leaves other tenants alone', async () => {
    const gone = await seedOrg('Purged Co');
    const kept = await seedOrg('Kept Co');
    await sql(
      `UPDATE organizations SET deletion_requested_at = now() - interval '31 days', deletion_scheduled_for = now() - interval '1 day' WHERE id = $1`,
      [gone.org],
    );
    // Not yet due: still inside its grace period.
    await sql(
      `UPDATE organizations SET deletion_requested_at = now(), deletion_scheduled_for = now() + interval '30 days' WHERE id = $1`,
      [kept.org],
    );
    const out = await purgeDueTenants({
      prisma,
      scheduler,
      now: () => new Date(),
      vmUrl: `http://127.0.0.1:${vmPort}`,
    });
    expect(out).toEqual({ purged: [gone.org] });
    expect(await remaining(gone.org)).toEqual({});
    expect(Object.keys(await remaining(kept.org)).length).toBeGreaterThan(5);
    expect(vmCalls).toContain(`POST /api/v1/admin/tsdb/delete_series?match[]={tenant_id="${gone.org}"}`);
    const [summary] = await sql(`SELECT name, summary FROM deleted_organizations WHERE id = $1`, [gone.org]);
    expect(summary).toMatchObject({
      name: 'Purged Co',
      summary: expect.objectContaining({ products: 1, connections: 1 }),
    });
  });

  it('expires export archives after 24 h', async () => {
    const a = await seedOrg('Exporter');
    const h = tenantHandlers({ prisma, now: () => new Date(Date.now() - 25 * 3600 * 1000) });
    await h['tenant-export'](ctx(a.org), a.exportId);
    await purgeDueTenants({ prisma, scheduler, now: () => new Date(), vmUrl: `http://127.0.0.1:${vmPort}` });
    const [row] = await sql(`SELECT status, archive FROM tenant_exports WHERE id = $1`, [a.exportId]);
    expect(row).toEqual({ status: 'expired', archive: null });
  });
});
