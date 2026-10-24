import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, type TestDatabase } from './testing.js';

let db: TestDatabase;
const [orgA, orgB] = [randomUUID(), randomUUID()];

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
async function asTenant(org: string, text: string) {
  const c = new pg.Client({ connectionString: db.appUrl });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.organization_id', $1, true)`, [org]);
    const rows = (await c.query(text)).rows;
    await c.query('COMMIT');
    return rows;
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  db = await startPostgres();
  await su(`INSERT INTO organizations (id, name) VALUES ($1, 'A'), ($2, 'B')`, [orgA, orgB]);
  await su(
    `INSERT INTO telemetry_usage (organization_id, minute, active_series, samples, refused_series_requests, refused_rate_requests)
     VALUES ($1, '2026-10-25T10:00:00Z', 120, 3600, 0, 0)`,
    [orgA],
  );
}, 180_000);

afterAll(async () => {
  await db?.stop();
});

describe('usage and live boosts schema (M10.6, M10.7)', () => {
  it('isolates usage rows and boosts per organization', async () => {
    expect((await asTenant(orgA, `SELECT count(*)::int AS n FROM telemetry_usage`))[0].n).toBe(1);
    expect((await asTenant(orgB, `SELECT count(*)::int AS n FROM telemetry_usage`))[0].n).toBe(0);
    expect((await asTenant(orgB, `SELECT count(*)::int AS n FROM agent_live_boosts`))[0].n).toBe(0);
  });

  it('keeps one usage row per organization and minute', async () => {
    await expect(
      su(
        `INSERT INTO telemetry_usage (organization_id, minute, active_series, samples) VALUES ($1, '2026-10-25T10:00:00Z', 1, 1)`,
        [orgA],
      ),
    ).rejects.toThrow(/duplicate key/);
  });
});
