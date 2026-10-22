import pg from 'pg';
import { inject } from 'vitest';

/** Superuser SQL for test setup only (bypasses RLS). */
export async function sql<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values: unknown[] = [],
) {
  const client = new pg.Client({ connectionString: inject('superuserDbUrl') });
  await client.connect();
  try {
    return (await client.query<T>(text, values)).rows;
  } finally {
    await client.end();
  }
}
