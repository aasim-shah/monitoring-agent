import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, type TestDatabase } from './testing.js';

let db: TestDatabase;
const org = randomUUID();
const product = randomUUID();
const environment = randomUUID();
const member = randomUUID();
const agent = randomUUID();
const fingerprint = createHash('sha256').update(randomUUID()).digest('hex');

async function query<T extends pg.QueryResultRow>(url: string, text: string, values: unknown[] = []) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query<T>(text, values)).rows;
  } finally {
    await c.end();
  }
}

async function enrollment(opts: { maxUses?: number; expiresIn?: string; revoked?: boolean } = {}) {
  const hash = createHash('sha256').update(randomUUID()).digest('hex');
  await query(
    db.superuserUrl,
    `INSERT INTO agent_enrollments (id, organization_id, product_id, environment_id, token_hash, expires_at, max_uses, revoked_at)
     VALUES ($1, $2, $3, $4, $5, now() + $6::interval, $7, $8)`,
    [
      randomUUID(),
      org,
      product,
      environment,
      hash,
      opts.expiresIn ?? '1 hour',
      opts.maxUses ?? 1,
      opts.revoked ? new Date() : null,
    ],
  );
  return hash;
}

const consume = (hash: string) =>
  query<{ organization_id: string; product_id: string; environment_id: string }>(
    db.appUrl,
    `SELECT * FROM pcp_consume_enrollment($1)`,
    [hash],
  );

beforeAll(async () => {
  db = await startPostgres();
  const su = db.superuserUrl;
  await query(su, `INSERT INTO users (id, email) VALUES ($1, 'm@example.com')`, [member]);
  await query(su, `INSERT INTO organizations (id, name) VALUES ($1, 'Org')`, [org]);
  await query(
    su,
    `INSERT INTO organization_members (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'owner')`,
    [randomUUID(), org, member],
  );
  await query(su, `INSERT INTO products (id, organization_id, name) VALUES ($1, $2, 'P')`, [product, org]);
  await query(
    su,
    `INSERT INTO environments (id, organization_id, product_id, name) VALUES ($1, $2, $3, 'production')`,
    [environment, org, product],
  );
  const enr = randomUUID();
  await query(
    su,
    `INSERT INTO agent_enrollments (id, organization_id, product_id, environment_id, token_hash, expires_at, max_uses)
     VALUES ($1, $2, $3, $4, 'seed', now() + interval '1 hour', 1)`,
    [enr, org, product, environment],
  );
  await query(
    su,
    `INSERT INTO agents (id, organization_id, product_id, environment_id, enrollment_id, agent_type, hostname, machine_id, os, arch, agent_version)
     VALUES ($1, $2, $3, $4, $5, 'host', 'vps-1', 'm1', 'ubuntu-24.04', 'amd64', '1.0.0')`,
    [agent, org, product, environment, enr],
  );
  await query(
    su,
    `INSERT INTO agent_credentials (id, organization_id, agent_id, fingerprint_sha256, serial, not_after)
     VALUES ($1, $2, $3, $4, 'serial-1', now() + interval '30 days')`,
    [randomUUID(), org, agent, fingerprint],
  );
}, 180_000);

afterAll(async () => {
  await db?.stop();
});

describe('agent data model', () => {
  it('consumes a max_uses 1 enrollment exactly once, with tenant fields', async () => {
    const hash = await enrollment();
    expect(await consume(hash)).toEqual([
      expect.objectContaining({ organization_id: org, product_id: product, environment_id: environment }),
    ]);
    expect(await consume(hash)).toEqual([]);
  });

  it('returns nothing for expired, revoked, and unknown tokens', async () => {
    expect(await consume(await enrollment({ expiresIn: '-1 minute' }))).toEqual([]);
    expect(await consume(await enrollment({ revoked: true }))).toEqual([]);
    expect(await consume('0'.repeat(64))).toEqual([]);
  });

  it('never exceeds max_uses under concurrency (Review Focus #1)', async () => {
    const hash = await enrollment({ maxUses: 3 });
    const results = await Promise.all(Array.from({ length: 10 }, () => consume(hash)));
    expect(results.filter((r) => r.length === 1)).toHaveLength(3);
  });

  it('resolves an agent by certificate fingerprint', async () => {
    const [row] = await query(db.appUrl, `SELECT * FROM pcp_agent_by_fingerprint($1)`, [fingerprint]);
    expect(row).toMatchObject({
      agent_id: agent,
      organization_id: org,
      product_id: product,
      agent_status: 'active',
    });
    expect(await query(db.appUrl, `SELECT * FROM pcp_agent_by_fingerprint($1)`, ['f'.repeat(64)])).toEqual(
      [],
    );
  });

  it('resolves an agent organization and product only for members', async () => {
    const [m] = await query<{ org: string; product: string }>(
      db.appUrl,
      `SELECT pcp_resolve_agent_org($1, $2) AS org, pcp_resolve_agent_product($1, $2) AS product`,
      [agent, member],
    );
    expect(m).toEqual({ org, product });
    const [s] = await query<{ org: string | null }>(
      db.appUrl,
      `SELECT pcp_resolve_agent_org($1, $2) AS org`,
      [agent, randomUUID()],
    );
    expect(s!.org).toBeNull();
  });

  it('hides enrollments from the app role without tenant context', async () => {
    expect(await query(db.appUrl, `SELECT * FROM agent_enrollments`)).toEqual([]);
  });

  it('allows one assignment per pack per agent', async () => {
    const insert = () =>
      query(
        db.superuserUrl,
        `INSERT INTO agent_pack_assignments (id, organization_id, agent_id, pack_id, settings, policy_version, updated_at)
         VALUES ($1, $2, $3, 'postgresql', '{}', 2, now())`,
        [randomUUID(), org, agent],
      );
    await insert();
    await expect(insert()).rejects.toThrow(/duplicate key/);
  });
});
