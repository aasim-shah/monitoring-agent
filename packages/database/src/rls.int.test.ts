import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TENANT_TABLES } from './index.js';
import { startPostgres, type TestDatabase } from './testing.js';

let db: TestDatabase;
const orgA = randomUUID();
const orgB = randomUUID();
const userA = randomUUID();

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function asApp<T>(org: string | null, fn: (c: pg.Client) => Promise<T>, user?: string): Promise<T> {
  return withClient(db.appUrl, async (c) => {
    await c.query('BEGIN');
    try {
      if (org) await c.query(`SELECT set_config('app.organization_id', $1, true)`, [org]);
      if (user) await c.query(`SELECT set_config('app.user_id', $1, true)`, [user]);
      return await fn(c);
    } finally {
      await c.query('ROLLBACK');
    }
  });
}

beforeAll(async () => {
  db = await startPostgres();
  await withClient(db.superuserUrl, async (c) => {
    await c.query(`INSERT INTO users (id, email) VALUES ($1, 'a@example.com')`, [userA]);
    for (const [org, name] of [
      [orgA, 'Org A'],
      [orgB, 'Org B'],
    ]) {
      await c.query(`INSERT INTO organizations (id, name) VALUES ($1, $2)`, [org, name]);
      const product = randomUUID();
      await c.query(`INSERT INTO products (id, organization_id, name) VALUES ($1, $2, 'P')`, [product, org]);
      await c.query(
        `INSERT INTO environments (id, organization_id, product_id, name) VALUES ($1, $2, $3, 'Production')`,
        [randomUUID(), org, product],
      );
      await c.query(`INSERT INTO teams (id, organization_id, name) VALUES ($1, $2, 'Core')`, [
        randomUUID(),
        org,
      ]);
      await c.query(
        `INSERT INTO invitations (id, organization_id, email, role, token_hash, invited_by_user_id, expires_at)
         VALUES ($1, $2, 'x@example.com', 'viewer', $3, $4, now() + interval '7 days')`,
        [randomUUID(), org, `hash-${org}`, userA],
      );
      await c.query(
        `INSERT INTO audit_logs (id, organization_id, actor_type, action, target_type) VALUES ($1, $2, 'system', 'seed', 'organization')`,
        [randomUUID(), org],
      );
    }
    await c.query(
      `INSERT INTO organization_members (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'owner'), ($4, $5, $3, 'viewer')`,
      [randomUUID(), orgA, userA, randomUUID(), orgB],
    );
  });
}, 180_000);

afterAll(async () => {
  await db?.stop();
});

describe('row-level security', () => {
  it('every tenant table has RLS enabled and forced', async () => {
    const rows = await withClient(
      db.superuserUrl,
      async (c) =>
        (
          await c.query(
            `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY($1) AND relkind = 'r'`,
            [TENANT_TABLES],
          )
        ).rows,
    );
    expect(rows).toHaveLength(TENANT_TABLES.length);
    for (const r of rows) {
      expect(r, r.relname).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    }
  });

  it.each(TENANT_TABLES)('%s returns no rows without tenant context', async (table) => {
    const { rows } = await asApp(null, (c) => c.query(`SELECT count(*)::int AS n FROM ${table}`));
    expect(rows[0].n).toBe(0);
  });

  it.each(TENANT_TABLES)('%s returns only the current tenant rows', async (table) => {
    const column = table === 'organizations' ? 'id' : 'organization_id';
    const { rows } = await asApp(orgA, (c) => c.query(`SELECT DISTINCT ${column} AS org FROM ${table}`));
    expect(rows.map((r) => r.org)).toEqual([orgA]);
  });

  it('rejects writing another tenant row', async () => {
    await expect(
      asApp(orgA, (c) =>
        c.query(`INSERT INTO products (id, organization_id, name) VALUES ($1, $2, 'evil')`, [
          randomUUID(),
          orgB,
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('lists the user memberships across organizations without tenant context', async () => {
    const { rows } = await asApp(null, (c) =>
      c.query(`SELECT organization_id, role FROM pcp_user_memberships($1) ORDER BY role`, [userA]),
    );
    expect(rows).toEqual([
      { organization_id: orgA, role: 'owner' },
      { organization_id: orgB, role: 'viewer' },
    ]);
  });

  it('resolves a product organization only for members', async () => {
    const product = await withClient(
      db.superuserUrl,
      async (c) => (await c.query(`SELECT id FROM products WHERE organization_id = $1`, [orgA])).rows[0].id,
    );
    const member = await asApp(null, (c) =>
      c.query(`SELECT pcp_resolve_product_org($1, $2) AS org`, [product, userA]),
    );
    expect(member.rows[0].org).toBe(orgA);
    const stranger = await asApp(null, (c) =>
      c.query(`SELECT pcp_resolve_product_org($1, $2) AS org`, [product, randomUUID()]),
    );
    expect(stranger.rows[0].org).toBeNull();
  });
});

describe('database roles', () => {
  it('pcp_app cannot bypass RLS and owns nothing', async () => {
    await withClient(db.superuserUrl, async (c) => {
      const role = await c.query(`SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'pcp_app'`);
      expect(role.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
      const owned = await c.query(
        `SELECT count(*)::int AS n FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE r.rolname = 'pcp_app'`,
      );
      expect(owned.rows[0].n).toBe(0);
    });
  });

  it('pcp_app cannot update or delete audit logs', async () => {
    await expect(asApp(orgA, (c) => c.query(`UPDATE audit_logs SET action = 'x'`))).rejects.toThrow(
      /permission denied/,
    );
    await expect(asApp(orgA, (c) => c.query(`DELETE FROM audit_logs`))).rejects.toThrow(/permission denied/);
  });

  it('pcp_app cannot read the Prisma migrations table', async () => {
    await expect(asApp(null, (c) => c.query(`SELECT * FROM _prisma_migrations`))).rejects.toThrow(
      /permission denied/,
    );
  });
});
