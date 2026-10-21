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
  it('compose refuses to start without POSTGRES_PASSWORD', async () => {
    const file = envFile({ REDIS_PASSWORD: SECRETS.REDIS_PASSWORD });
    const r = await compose('pcp-smoke-config', file, ['config']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('POSTGRES_PASSWORD');
  });

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
  ['managed', '18080'],
  ['self_hosted', '18081'],
])('stack in %s mode', (mode, httpPort) => {
  const project = `pcp-smoke-${mode.replace('_', '-')}`;
  const file = envFile({
    ...SECRETS,
    DEPLOYMENT_MODE: mode,
    HTTP_PORT: httpPort,
    HTTPS_PORT: String(Number(httpPort) + 400),
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

  it('bootstrap mode refuses agent, OAuth, and webhook routes', async () => {
    for (const path of ['/agent/v1/enroll', '/webhooks/github/x', '/api/v1/oauth/google/callback']) {
      const res = await fetch(`http://127.0.0.1:${httpPort}${path}`, { method: 'POST' });
      expect(res.status, path).toBe(503);
    }
  });
});
