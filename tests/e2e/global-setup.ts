import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_URL, E2E_HTTP_PORT, MAILPIT_PORT, PROJECT } from './helpers/env';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

function compose(envFile: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'docker',
      [
        'compose',
        '-p',
        PROJECT,
        '--env-file',
        envFile,
        '-f',
        'compose.yaml',
        '-f',
        'tests/e2e/compose.e2e.yaml',
        ...args,
      ],
      {
        cwd: repoRoot,
        stdio: 'inherit',
        env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
      },
    );
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`docker compose ${args[0]} exited ${code}`)),
    );
  });
}

/** Brings up the full stack (plus Mailpit) once; returns the teardown. */
export default async function globalSetup() {
  const dir = mkdtempSync(join(tmpdir(), 'pcp-e2e-'));
  const envFile = join(dir, '.env');
  writeFileSync(
    envFile,
    Object.entries({
      POSTGRES_SUPERUSER_PASSWORD: 'e2e0superuser',
      PCP_MIGRATOR_PASSWORD: 'e2e0migrator',
      PCP_APP_PASSWORD: 'e2e0app',
      PCP_SCHEDULER_PASSWORD: 'e2e0scheduler',
      REDIS_PASSWORD: 'e2e0redis',
      MASTER_KEY: Buffer.alloc(32, 9).toString('base64'),
      HTTP_PORT: String(E2E_HTTP_PORT),
      HTTPS_PORT: String(E2E_HTTP_PORT + 400),
      EDGE_SUBNET: '172.31.9.0/24',
      CADDY_ADDRESS: '172.31.9.10',
      MAILPIT_PORT: String(MAILPIT_PORT),
      APP_ORIGIN: BASE_URL,
    })
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') + '\n',
  );
  await compose(envFile, ['up', '-d', '--build', '--wait', '--wait-timeout', '400']);
  return async () => {
    if (!process.env.E2E_KEEP_STACK) await compose(envFile, ['down', '-v', '--remove-orphans']);
  };
}
