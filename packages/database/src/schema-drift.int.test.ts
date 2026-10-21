import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prismaCli } from './migrate.js';
import { startPostgres, type TestDatabase } from './testing.js';

let db: TestDatabase;

beforeAll(async () => {
  db = await startPostgres({ shadowDatabase: 'pcp_shadow' });
}, 180_000);

afterAll(async () => {
  await db?.stop();
});

describe('schema drift', () => {
  it('migrations match schema.prisma', async () => {
    const result = await prismaCli(
      [
        'migrate',
        'diff',
        '--from-migrations',
        'prisma/migrations',
        '--to-schema-datamodel',
        'prisma/schema.prisma',
        '--shadow-database-url',
        db.shadowUrl!,
        '--exit-code',
      ],
      { DATABASE_URL: db.migratorUrl },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
});
