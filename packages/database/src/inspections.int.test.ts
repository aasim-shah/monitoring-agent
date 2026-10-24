import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, type TestDatabase } from './testing.js';

let db: TestDatabase;

async function run(url: string, text: string, values: unknown[] = []) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query(text, values)).rows;
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  db = await startPostgres();
}, 180_000);

afterAll(async () => {
  await db?.stop();
});

describe('data inspection (M18.2)', () => {
  it('pack assignments start with inspection off', async () => {
    const [col] = await run(
      db.superuserUrl,
      `SELECT column_default, is_nullable FROM information_schema.columns WHERE table_name = 'agent_pack_assignments' AND column_name = 'inspection'`,
    );
    expect(col).toEqual({ column_default: `'{"enabled": false}'::jsonb`, is_nullable: 'NO' });
  });

  it('keeps each organization to its own inspection requests', async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    await run(db.superuserUrl, `INSERT INTO organizations (id, name) VALUES ($1, 'A'), ($2, 'B')`, [a, b]);
    for (const org of [a, b])
      await run(
        db.superuserUrl,
        `INSERT INTO inspection_requests (organization_id, agent_id, pack_id, target, status) VALUES ($1, gen_random_uuid(), 'redis', 'redis', 'queued')`,
        [org],
      );
    const c = new pg.Client({ connectionString: db.appUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.organization_id', $1, true)`, [a]);
      const rows = (await c.query('SELECT organization_id FROM inspection_requests')).rows;
      await c.query('COMMIT');
      expect(rows).toEqual([{ organization_id: a }]);
    } finally {
      await c.end();
    }
  });
});

describe('retained logs (M18.1)', () => {
  it('every organization gets its own logs AccountID, also when the app creates it', async () => {
    const c = new pg.Client({ connectionString: db.appUrl });
    await c.connect();
    const ids: number[] = [];
    try {
      for (const id of [randomUUID(), randomUUID()]) {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.organization_id', $1, true)`, [id]);
        ids.push(
          (
            await c.query(`INSERT INTO organizations (id, name) VALUES ($1, 'L') RETURNING logs_account_id`, [
              id,
            ])
          ).rows[0].logs_account_id,
        );
        await c.query('COMMIT');
      }
    } finally {
      await c.end();
    }
    expect(ids[0]).toBeGreaterThan(0);
    expect(ids[1]).not.toBe(ids[0]);
  });
});
