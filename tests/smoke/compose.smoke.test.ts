import { afterAll, describe, expect, it } from 'vitest';
import { SECRETS, compose, envFile } from './compose.js';

const STORAGE_AND_APP = [
  'postgres',
  'redis',
  'victoriametrics',
  'vmalert',
  'api',
  'worker',
  'web',
  'opamp-server',
  'ingest-gateway',
];

describe('compose configuration', () => {
  it.each(['POSTGRES_SUPERUSER_PASSWORD', 'PCP_APP_PASSWORD', 'MASTER_KEY', 'INTERNAL_TOKEN'])(
    'compose refuses to start without %s',
    async (name) => {
      const { [name as keyof typeof SECRETS]: _omit, ...rest } = SECRETS;
      const r = await compose('pcp-smoke-config', envFile(rest), ['config']);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain(name);
    },
  );

  it('storage ports are not published; only caddy publishes', async () => {
    const file = envFile(SECRETS);
    const r = await compose('pcp-smoke-config', file, ['config', '--format', 'json']);
    expect(r.status, r.stderr).toBe(0);
    const services = JSON.parse(r.stdout).services as Record<string, { ports?: unknown[] }>;
    for (const name of STORAGE_AND_APP) {
      expect(services[name], `service ${name} missing`).toBeDefined();
      expect(services[name]!.ports ?? [], `${name} must not publish ports`).toEqual([]);
    }
    expect((services.caddy!.ports ?? []).length).toBe(2);
  });
});

describe.each([
  ['managed', '18080', '172.31.1'],
  ['self_hosted', '18081', '172.31.2'],
])('stack in %s mode', (mode, httpPort, subnet) => {
  const project = `pcp-smoke-${mode.replace('_', '-')}`;
  const file = envFile({
    ...SECRETS,
    DEPLOYMENT_MODE: mode,
    HTTP_PORT: httpPort,
    HTTPS_PORT: String(Number(httpPort) + 400),
    // Each stack gets its own edge subnet so it can run beside a dev stack.
    EDGE_SUBNET: `${subnet}.0/24`,
    CADDY_ADDRESS: `${subnet}.10`,
  });

  afterAll(async () => {
    await compose(project, file, ['down', '-v', '--remove-orphans']);
  });

  it(`stack becomes healthy in ${mode}`, async () => {
    const up = await compose(project, file, ['up', '-d', '--build', '--wait', '--wait-timeout', '300']);
    expect(up.status, up.stderr.slice(-4000)).toBe(0);

    const health = await fetch(`http://127.0.0.1:${httpPort}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok', service: 'api', deploymentMode: mode });

    const home = await fetch(`http://127.0.0.1:${httpPort}/`);
    expect(home.status).toBe(200);
    expect(await home.text()).toContain('Product Control Plane');
  });

  it('migrations ran and sign-up works through Caddy', async () => {
    const ps = await compose(project, file, ['ps', '-a', '--format', 'json', 'migrate']);
    const migrate = ps.stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { State: string; ExitCode: number });
    expect(migrate[0]).toMatchObject({ State: 'exited', ExitCode: 0 });

    const res = await fetch(`http://127.0.0.1:${httpPort}/api/v1/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `smoke-${mode}@example.com`, password: 'smoke test password' }),
    });
    expect(res.status).toBe(202);
  });

  it('worker is ready with PostgreSQL and Redis', async () => {
    const r = await compose(project, file, [
      'exec',
      '-T',
      'worker',
      'wget',
      '-q',
      '-O',
      '-',
      'http://127.0.0.1:3002/readyz',
    ]);
    expect(r.status, r.stderr).toBe(0);
    const report = JSON.parse(r.stdout) as { status: string; checks: { name: string; ok: boolean }[] };
    expect(report.status).toBe('ready');
    expect(report.checks.map((c) => c.name).sort()).toEqual(['postgres', 'redis']);
  });

  it('bootstrap mode refuses agent, OAuth, and webhook routes', async () => {
    for (const path of ['/agent/v1/enroll', '/webhooks/github/x', '/api/v1/oauth/google/callback']) {
      const res = await fetch(`http://127.0.0.1:${httpPort}${path}`, { method: 'POST' });
      expect(res.status, path).toBe(503);
    }
  });
});
