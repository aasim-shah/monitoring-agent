import { mkdtempSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repoRoot, run } from './compose.js';

// The production database stand-in: a throwaway Postgres with a database named pcp.
const PG = `pcp-backup-test-${process.pid}`;
const BACKUP = `${repoRoot}infrastructure/scripts/backup.sh`;
const DRILL = `${repoRoot}infrastructure/scripts/restore-drill.sh`;

const psql = (sql: string) => run('docker', ['exec', PG, 'psql', '-U', 'postgres', '-d', 'pcp', '-tAc', sql]);

function dir() {
  const d = mkdtempSync(join(tmpdir(), 'pcp-backups-'));
  writeFileSync(join(d, '.env'), 'MASTER_KEY=test-master-key\n');
  return d;
}

const dumps = (d: string) =>
  readdirSync(join(d, 'backups', 'nightly'))
    .filter((f) => f.endsWith('.dump'))
    .sort();

beforeAll(async () => {
  const up = await run('docker', [
    'run',
    '-d',
    '--rm',
    '--name',
    PG,
    '--memory',
    '256m',
    '-e',
    'POSTGRES_PASSWORD=x',
    '-e',
    'POSTGRES_DB=pcp',
    'postgres:17.6-alpine',
  ]);
  expect(up.status, up.stderr).toBe(0);
  for (let i = 0; i < 60; i++) {
    if ((await psql('SELECT 1')).stdout.trim() === '1') break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  await psql(
    `CREATE TABLE organizations (id int primary key, name text); CREATE TABLE users (id int primary key);
     CREATE TABLE connections (id int primary key);
     INSERT INTO organizations VALUES (1, 'Acme'), (2, 'Beta'); INSERT INTO users VALUES (1), (2), (3);`,
  );
}, 180_000);

afterAll(async () => {
  await run('docker', ['rm', '-f', PG]);
});

describe('nightly backup (M19.3)', () => {
  it('writes a verified dump and a copy of .env (holds the master key), both mode 600', async () => {
    const d = dir();
    const r = await run('bash', [BACKUP], { PCP_DIR: d, PG_CONTAINER: PG, MIN_FREE_MB: '1' });
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const [file] = dumps(d);
    expect(file).toMatch(/^pcp-\d{8}T\d{6}Z\.dump$/);
    expect(statSync(join(d, 'backups', 'nightly', file!)).mode & 0o777).toBe(0o600);
    const env = readdirSync(join(d, 'backups', 'nightly')).find((f) => f.startsWith('env-'));
    expect(statSync(join(d, 'backups', 'nightly', env!)).mode & 0o777).toBe(0o600);
    expect(r.stdout).toMatch(/backup ok: pcp-.*\.dump/);
  });

  it('a failing dump leaves no new file and deletes nothing (Review Focus #1)', async () => {
    const d = dir();
    await run('bash', [BACKUP], { PCP_DIR: d, PG_CONTAINER: PG, MIN_FREE_MB: '1' });
    const before = dumps(d);
    const r = await run('bash', [BACKUP], {
      PCP_DIR: d,
      PG_CONTAINER: 'no-such-container',
      MIN_FREE_MB: '1',
      KEEP_DAYS: '0',
    });
    expect(r.status).not.toBe(0);
    expect(dumps(d)).toEqual(before);
    expect(readdirSync(join(d, 'backups', 'nightly')).some((f) => f.endsWith('.partial'))).toBe(false);
  });

  it('refuses to run with too little free disk, and says so', async () => {
    const d = dir();
    const r = await run('bash', [BACKUP], { PCP_DIR: d, PG_CONTAINER: PG, MIN_FREE_MB: '999999999' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/not enough free disk/);
  });

  it('removes dumps older than the retention after a good backup', async () => {
    const d = dir();
    await run('bash', [BACKUP], { PCP_DIR: d, PG_CONTAINER: PG, MIN_FREE_MB: '1' });
    const [old] = dumps(d);
    const past = new Date(Date.now() - 20 * 86_400_000);
    utimesSync(join(d, 'backups', 'nightly', old!), past, past);
    await new Promise((r) => setTimeout(r, 1100));
    const r = await run('bash', [BACKUP], {
      PCP_DIR: d,
      PG_CONTAINER: PG,
      MIN_FREE_MB: '1',
      KEEP_DAYS: '14',
    });
    expect(r.status, r.stderr).toBe(0);
    expect(dumps(d)).not.toContain(old);
    expect(dumps(d)).toHaveLength(1);
  });

  it('the restore drill restores into a separate container and reports row counts (Review Focus #2)', async () => {
    const d = dir();
    await run('bash', [BACKUP], { PCP_DIR: d, PG_CONTAINER: PG, MIN_FREE_MB: '1' });
    const [file] = dumps(d);
    const r = await run('bash', [DRILL, join(d, 'backups', 'nightly', file!)]);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).toContain('organizations 2');
    expect(r.stdout).toContain('users 3');
    expect(r.stdout).toMatch(/restore drill ok/);
    // The drill container is gone and the source database is untouched.
    expect(
      (await run('docker', ['ps', '-a', '--filter', 'name=pcp-restore-drill', '-q'])).stdout.trim(),
    ).toBe('');
    expect((await psql('SELECT count(*) FROM organizations')).stdout.trim()).toBe('2');
  });
});
