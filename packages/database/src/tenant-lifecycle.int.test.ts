import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_PASSWORDS, startPostgres, type TestDatabase } from './testing.js';
import { withCredentials } from './urls.js';

let db: TestDatabase;
const [orgA, orgB, owner, analyst, productA, productB] = [
  randomUUID(),
  randomUUID(),
  randomUUID(),
  randomUUID(),
  randomUUID(),
  randomUUID(),
];

async function run(url: string, text: string, values: unknown[] = []) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query(text, values)).rows;
  } finally {
    await c.end();
  }
}
const su = (q: string, v: unknown[] = []) => run(db.superuserUrl, q, v);
const scheduler = (q: string, v: unknown[] = []) =>
  run(withCredentials(db.superuserUrl, 'pcp_scheduler', TEST_PASSWORDS.scheduler), q, v);

beforeAll(async () => {
  db = await startPostgres();
  await su(`INSERT INTO organizations (id, name) VALUES ($1, 'Leaving'), ($2, 'Staying')`, [orgA, orgB]);
  await su(`INSERT INTO users (id, email) VALUES ($1, 'o@x.test'), ($2, 'a@x.test')`, [owner, analyst]);
  await su(
    `INSERT INTO organization_members (id, organization_id, user_id, role) VALUES
       (gen_random_uuid(), $1, $3, 'owner'), (gen_random_uuid(), $1, $4, 'analyst'), (gen_random_uuid(), $2, $4, 'analyst')`,
    [orgA, orgB, owner, analyst],
  );
  await su(`INSERT INTO products (id, organization_id, name) VALUES ($1, $2, 'P'), ($3, $4, 'Q')`, [
    productA,
    orgA,
    productB,
    orgB,
  ]);
  for (const [org, product] of [
    [orgA, productA],
    [orgB, productB],
  ])
    await su(
      `INSERT INTO report_schedules (organization_id, product_id, name, timezone, local_time, next_run_at, updated_at)
       VALUES ($1, $2, 'Daily', 'UTC', '08:00', now() - interval '1 minute', now())`,
      [org, product],
    );
  await su(
    `UPDATE organizations SET deletion_requested_at = now(), deletion_scheduled_for = now() + interval '30 days' WHERE id = $1`,
    [orgA],
  );
}, 180_000);

afterAll(async () => {
  await db?.stop();
});

describe('tenant deletion lifecycle (WB-17 UC-17-09)', () => {
  it('a pending-deletion organization is hidden from members but not from owners', async () => {
    const forUser = (u: string) =>
      run(db.appUrl, `SELECT organization_name FROM pcp_user_memberships($1) ORDER BY 1`, [u]);
    expect((await forUser(analyst)).map((r) => r.organization_name)).toEqual(['Staying']);
    expect((await forUser(owner)).map((r) => r.organization_name)).toEqual(['Leaving']);
  });

  it('report schedules of a pending-deletion organization are not dispatched', async () => {
    const due = await scheduler(`SELECT organization_id FROM pcp_due_report_schedules(now())`);
    expect(due.map((r) => r.organization_id)).toEqual([orgB]);
  });

  it('lists organizations due for purge only after their grace period', async () => {
    expect(await scheduler(`SELECT id FROM pcp_due_tenant_purges(now())`)).toEqual([]);
    expect(await scheduler(`SELECT id FROM pcp_due_tenant_purges(now() + interval '31 days')`)).toEqual([
      { id: orgA },
    ]);
  });

  it('isolates export archives per organization', async () => {
    await su(
      `INSERT INTO tenant_exports (organization_id, requested_by_user_id, status) VALUES ($1, $2, 'queued')`,
      [orgA, owner],
    );
    const as = async (org: string) => {
      const c = new pg.Client({ connectionString: db.appUrl });
      await c.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.organization_id', $1, true)`, [org]);
        return (await c.query(`SELECT count(*)::int AS n FROM tenant_exports`)).rows[0].n;
      } finally {
        await c.query('COMMIT');
        await c.end();
      }
    };
    expect(await as(orgA)).toBe(1);
    expect(await as(orgB)).toBe(0);
  });
});
