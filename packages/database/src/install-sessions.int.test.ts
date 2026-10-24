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

describe('install sessions (M17.3)', () => {
  it('TC-05-08: no column can hold a credential', async () => {
    const cols = await run(
      db.superuserUrl,
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_name IN ('install_sessions', 'install_session_hosts') ORDER BY table_name, ordinal_position`,
    );
    const by = (t: string) => cols.filter((c) => c.table_name === t).map((c) => c.column_name as string);
    expect(by('install_sessions')).toEqual([
      'id',
      'organization_id',
      'product_id',
      'environment_id',
      'enrollment_id',
      'mode',
      'status',
      'created_by_user_id',
      'expires_at',
      'created_at',
      'updated_at',
    ]);
    expect(by('install_session_hosts')).toEqual([
      'id',
      'organization_id',
      'session_id',
      'host',
      'port',
      'username',
      'fingerprint',
      'fingerprint_confirmed_at',
      'status',
      'output',
      'script_version',
      'cleanup',
      'error',
      'updated_at',
    ]);
    for (const c of cols) expect(c.column_name).not.toMatch(/password|secret|private|token|key$/);
  });

  it('keeps each organization to its own sessions', async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    const su = (q: string, v: unknown[] = []) => run(db.superuserUrl, q, v);
    await su(`INSERT INTO organizations (id, name) VALUES ($1, 'A'), ($2, 'B')`, [a, b]);
    for (const org of [a, b]) {
      const [p] = await su(`INSERT INTO products (organization_id, name) VALUES ($1, 'P') RETURNING id`, [org]);
      const [e] = await su(
        `INSERT INTO environments (organization_id, product_id, name) VALUES ($1, $2, 'prod') RETURNING id`,
        [org, p!.id],
      );
      const [s] = await su(
        `INSERT INTO install_sessions (organization_id, product_id, environment_id, mode, status, expires_at, updated_at)
         VALUES ($1, $2, $3, 'key', 'awaiting_key', now() + interval '1 hour', now()) RETURNING id`,
        [org, p!.id, e!.id],
      );
      await su(
        `INSERT INTO install_session_hosts (organization_id, session_id, host, port, username, status, updated_at)
         VALUES ($1, $2, '10.0.0.1', 22, 'pcp-install', 'pending', now())`,
        [org, s!.id],
      );
    }
    const c = new pg.Client({ connectionString: db.appUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.organization_id', $1, true)`, [a]);
      const sessions = (await c.query('SELECT organization_id FROM install_sessions')).rows;
      const hosts = (await c.query('SELECT organization_id FROM install_session_hosts')).rows;
      await c.query('COMMIT');
      expect(sessions).toEqual([{ organization_id: a }]);
      expect(hosts).toEqual([{ organization_id: a }]);
    } finally {
      await c.end();
    }
  });
});
