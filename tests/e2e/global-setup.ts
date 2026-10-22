import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_URL, CADDY_ADDRESS, E2E_HTTP_PORT, E2E_WORK_DIR, MAILPIT_PORT, PROJECT } from './helpers/env';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

/** Dev agent PKI from `pnpm --filter @pcp/api agent:pki`; returns the AGENT_CA_* / TASK_SIGNING_KEY lines. */
function agentPki(outDir: string): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', ['--filter', '@pcp/api', 'agent:pki', '--out', outDir], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'inherit'],
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve(
            Object.fromEntries(
              out
                .split('\n')
                .filter((l) => /^(AGENT_CA_|TASK_SIGNING_KEY)/.test(l))
                .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
            ),
          )
        : reject(new Error(`agent:pki exited ${code}`)),
    );
  });
}

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
  // Inside the repository so the Go agent container (mounted at /src) can read the Caddy root.
  const dir = E2E_WORK_DIR;
  mkdirSync(dir, { recursive: true });
  const envFile = join(dir, '.env');
  const pki = await agentPki(join(dir, 'pki'));
  writeFileSync(
    envFile,
    Object.entries({
      POSTGRES_SUPERUSER_PASSWORD: 'e2e0superuser',
      PCP_MIGRATOR_PASSWORD: 'e2e0migrator',
      PCP_APP_PASSWORD: 'e2e0app',
      PCP_SCHEDULER_PASSWORD: 'e2e0scheduler',
      REDIS_PASSWORD: 'e2e0redis',
      MASTER_KEY: Buffer.alloc(32, 9).toString('base64'),
      INTERNAL_TOKEN: 'e2e0internal0token0value0hex',
      HTTP_PORT: String(E2E_HTTP_PORT),
      HTTPS_PORT: String(E2E_HTTP_PORT + 400),
      EDGE_SUBNET: '172.31.9.0/24',
      CADDY_ADDRESS,
      // Local TLS for agent.localhost so the agent journey runs through Caddy's mTLS edge.
      CADDY_CONFIG: 'Caddyfile.local',
      AGENT_CA_DIR: join(dir, 'pki'),
      ...pki,
      AGENT_CONTROL_URL: 'https://agent.localhost',
      AGENT_INGEST_URL: 'https://ingest.localhost',
      AGENT_OPAMP_URL: 'wss://agent.localhost/agent/v1/opamp',
      MAILPIT_PORT: String(MAILPIT_PORT),
      APP_ORIGIN: BASE_URL,
    })
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') + '\n',
  );
  await compose(envFile, ['up', '-d', '--build', '--wait', '--wait-timeout', '600']);
  await compose(envFile, [
    'cp',
    'caddy:/data/caddy/pki/authorities/local/root.crt',
    join(dir, 'caddy-root.crt'),
  ]);
  return async () => {
    if (!process.env.E2E_KEEP_STACK) await compose(envFile, ['down', '-v', '--remove-orphans']);
  };
}
