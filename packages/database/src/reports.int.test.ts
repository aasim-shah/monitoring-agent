import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, type TestDatabase } from './testing.js';

let db: TestDatabase;
const [orgA, orgB] = [randomUUID(), randomUUID()];
const [productA, productB] = [randomUUID(), randomUUID()];
const [scheduleA, scheduleB, reportA] = [randomUUID(), randomUUID(), randomUUID()];
const T = '2026-10-26T07:00:00Z';

const schedulerUrl = () => {
  const u = new URL(db.superuserUrl);
  u.username = 'pcp_scheduler';
  u.password = 'test-scheduler';
  return u.toString();
};

async function run(url: string, text: string, values: unknown[] = []) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query(text, values)).rows;
  } finally {
    await c.end();
  }
}

/** As pcp_app inside one organization (withTenant sets the same settings). */
async function asTenant(org: string, text: string, values: unknown[] = []) {
  const c = new pg.Client({ connectionString: db.appUrl });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.organization_id', $1, true)`, [org]);
    const rows = (await c.query(text, values)).rows;
    await c.query('COMMIT');
    return rows;
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  db = await startPostgres();
  const su = (q: string, v: unknown[] = []) => run(db.superuserUrl, q, v);
  await su(`INSERT INTO organizations (id, name) VALUES ($1, 'A'), ($2, 'B')`, [orgA, orgB]);
  await su(`INSERT INTO products (id, organization_id, name) VALUES ($1, $2, 'P'), ($3, $4, 'P')`, [
    productA,
    orgA,
    productB,
    orgB,
  ]);
  // A is due; B is due but disabled.
  await su(
    `INSERT INTO report_schedules (id, organization_id, product_id, name, timezone, local_time, next_run_at, enabled, updated_at)
     VALUES ($1, $2, $3, 'Daily', 'Europe/Berlin', '08:00', $7, true, now()),
            ($4, $5, $6, 'Daily', 'Europe/Berlin', '08:00', $7, false, now())`,
    [scheduleA, orgA, productA, scheduleB, orgB, productB, T],
  );
  await su(
    `INSERT INTO generated_reports (id, organization_id, product_id, schedule_id, local_date, version, window_start, window_end, timezone, snapshot, narrative_status)
     VALUES ($1, $2, $3, $4, '2026-10-25', 1, '2026-10-24T22:00:00Z', '2026-10-25T23:00:00Z', 'Europe/Berlin', '{}', 'deferred')`,
    [reportA, orgA, productA, scheduleA],
  );
  await su(
    `INSERT INTO report_deliveries (id, organization_id, report_id, kind, target) VALUES ($1, $2, $3, 'email', 'ops@example.com')`,
    [randomUUID(), orgA, reportA],
  );
}, 180_000);

afterAll(async () => {
  await db?.stop();
});

describe('reports schema (WB-15 §6)', () => {
  it('isolates schedules, reports, and deliveries per organization', async () => {
    for (const table of ['report_schedules', 'generated_reports', 'report_deliveries']) {
      expect((await asTenant(orgB, `SELECT count(*)::int AS n FROM ${table}`))[0]!.n, table).toBe(
        table === 'report_schedules' ? 1 : 0,
      );
      expect((await asTenant(orgA, `SELECT count(*)::int AS n FROM ${table}`))[0]!.n, table).toBe(1);
    }
  });

  it('pcp_due_report_schedules returns enabled due schedules to the scheduler role only (BR-15-07)', async () => {
    const rows = await run(schedulerUrl(), `SELECT organization_id, id FROM pcp_due_report_schedules($1)`, [
      T,
    ]);
    expect(rows).toEqual([{ organization_id: orgA, id: scheduleA }]);
    expect(
      await run(schedulerUrl(), `SELECT id FROM pcp_due_report_schedules($1)`, ['2026-10-26T06:59:00Z']),
    ).toEqual([]);
    await expect(run(db.appUrl, `SELECT id FROM pcp_due_report_schedules($1)`, [T])).rejects.toThrow(
      /permission denied/,
    );
  });

  it('pcp_advance_report_schedule is compare-and-set', async () => {
    const advance = () =>
      run(schedulerUrl(), `SELECT pcp_advance_report_schedule($1, $2, $3) AS ok`, [
        scheduleA,
        T,
        '2026-10-27T07:00:00Z',
      ]);
    expect((await advance())[0]!.ok).toBe(true);
    expect((await advance())[0]!.ok).toBe(false);
    const [row] = await run(db.superuserUrl, `SELECT next_run_at FROM report_schedules WHERE id = $1`, [
      scheduleA,
    ]);
    expect((row!.next_run_at as Date).toISOString()).toBe('2026-10-27T07:00:00.000Z');
  });

  it('keeps one report per schedule, local date, and version (BR-15-04, BR-15-06)', async () => {
    const insert = (version: number) =>
      run(
        db.superuserUrl,
        `INSERT INTO generated_reports (organization_id, product_id, schedule_id, local_date, version, window_start, window_end, timezone, snapshot, narrative_status)
         VALUES ($1, $2, $3, '2026-10-25', $4, now(), now(), 'Europe/Berlin', '{}', 'deferred')`,
        [orgA, productA, scheduleA, version],
      );
    await expect(insert(1)).rejects.toThrow(/duplicate key/);
    await insert(2);
  });

  it('pcp_resolve_report_object answers members only, with the product', async () => {
    const user = randomUUID();
    await run(db.superuserUrl, `INSERT INTO users (id, email) VALUES ($1, $2)`, [
      user,
      `${user}@example.com`,
    ]);
    await run(
      db.superuserUrl,
      `INSERT INTO organization_members (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'viewer')`,
      [randomUUID(), orgA, user],
    );
    const q = (kind: string, id: string, u: string) =>
      run(db.appUrl, `SELECT organization_id, product_id FROM pcp_resolve_report_object($1, $2, $3)`, [
        kind,
        id,
        u,
      ]);
    expect(await q('report_schedule', scheduleA, user)).toEqual([
      { organization_id: orgA, product_id: productA },
    ]);
    expect(await q('report', reportA, user)).toEqual([{ organization_id: orgA, product_id: productA }]);
    expect(await q('report', reportA, randomUUID())).toEqual([]);
    expect(await q('report_schedule', scheduleB, user)).toEqual([]);
  });
});
