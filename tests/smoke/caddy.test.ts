import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot, run } from './compose.js';

async function selfSignedCa(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'pcp-ca-'));
  const r = await run('openssl', [
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:prime256v1',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=pcp-test-agent-ca',
    '-keyout',
    join(dir, 'ca.key'),
    '-out',
    join(dir, 'chain.pem'),
  ]);
  expect(r.status, r.stderr).toBe(0);
  writeFileSync(join(dir, '.keep'), '');
  return dir;
}

function validate(config: string, extraArgs: string[] = []) {
  return run('docker', [
    'run',
    '--rm',
    '-v',
    `${repoRoot}infrastructure/caddy:/etc/caddy:ro`,
    ...extraArgs,
    '-e',
    'APP_DOMAIN=app.example.com',
    '-e',
    'AGENT_DOMAIN=agent.example.com',
    '-e',
    'INGEST_DOMAIN=ingest.example.com',
    '-e',
    'ACME_EMAIL=ops@example.com',
    'caddy:2.10.2-alpine',
    'caddy',
    'validate',
    '--config',
    `/etc/caddy/${config}`,
    '--adapter',
    'caddyfile',
  ]);
}

describe('caddy routes', () => {
  // Bootstrap (plain HTTP before TLS) refuses webhooks with 503 instead; see compose.smoke.test.ts.
  it.each(['Caddyfile.local', 'Caddyfile.production', 'Caddyfile.behind-proxy'])(
    '%s sends provider webhooks to the API, not the dashboard',
    (name) => {
      const config = readFileSync(`${repoRoot}infrastructure/caddy/${name}`, 'utf8');
      expect(config).toMatch(/handle \/webhooks\/\* \{\s*reverse_proxy api:3000\s*\}/);
    },
  );
});

describe('caddy configs validate', () => {
  it('bootstrap config is valid', async () => {
    const r = await validate('Caddyfile.bootstrap');
    expect(r.status, r.stderr + r.stdout).toBe(0);
  });

  it('production config is valid with an agent CA chain', async () => {
    const ca = await selfSignedCa();
    const r = await validate('Caddyfile.production', ['-v', `${ca}:/etc/caddy-agent-ca:ro`]);
    expect(r.status, r.stderr + r.stdout).toBe(0);
  });
});
