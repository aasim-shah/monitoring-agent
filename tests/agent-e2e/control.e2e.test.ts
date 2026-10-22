import { createHmac } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SECRETS, compose as composeRun, envFile, repoRoot, run } from '../smoke/compose.js';

// M5 exit gate: a Go client enrolls through Caddy's mTLS edge (Caddyfile.local), heartbeats,
// answers a signed task, rotates its certificate, and is then revoked.

// API responses are read loosely here; the API's own tests pin their shapes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

const PROJECT = 'pcp-agent-e2e';
const HTTP_PORT = 18095;
const MAILPIT_PORT = 18245;
const SUBNET = '172.31.5';
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const ORIGIN = `http://localhost:${HTTP_PORT}`;

const work = mkdtempSync(join(repoRoot, 'tests/agent-e2e/.tmp-'));
let file = '';
const compose = (args: string[]) => composeRun(PROJECT, file, ['-f', 'tests/e2e/compose.e2e.yaml', ...args]);

async function pki(): Promise<Record<string, string>> {
  const out = await run('pnpm', ['--filter', '@pcp/api', 'agent:pki', '--out', join(work, 'pki')]);
  if (out.status !== 0) throw new Error(`agent:pki failed: ${out.stderr}`);
  return Object.fromEntries(
    out.stdout
      .split('\n')
      .filter((l) => /^(AGENT_CA_|TASK_SIGNING_KEY)/.test(l))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
}

function totp(secret: string, now = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret.replace(/=+$/, '')) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / 30)));
  const h = createHmac('sha1', key).update(counter).digest();
  const o = h[h.length - 1]! & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

let cookie = '';
async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', origin: ORIGIN, ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie?.startsWith('pcp_session=')) cookie = setCookie.split(';')[0]!;
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : {}) as Json };
}

async function until<T>(what: string, fn: () => Promise<T | undefined>, timeoutMs = 120_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for ${what}`);
}

beforeAll(async () => {
  file = envFile({
    ...SECRETS,
    ...(await pki()),
    CADDY_CONFIG: 'Caddyfile.local',
    AGENT_CA_DIR: join(work, 'pki'),
    AGENT_CONTROL_URL: 'https://agent.localhost',
    AGENT_INGEST_URL: 'https://ingest.localhost',
    AGENT_OPAMP_URL: 'wss://agent.localhost/agent/v1/opamp',
    APP_ORIGIN: ORIGIN,
    HTTP_PORT: String(HTTP_PORT),
    HTTPS_PORT: String(HTTP_PORT + 400),
    MAILPIT_PORT: String(MAILPIT_PORT),
    EDGE_SUBNET: `${SUBNET}.0/24`,
    CADDY_ADDRESS: `${SUBNET}.10`,
  });
  const up = await compose(['up', '-d', '--build', '--wait', '--wait-timeout', '600']);
  if (up.status !== 0) throw new Error(`compose up failed: ${up.stderr.slice(-4000)}`);
});

afterAll(async () => {
  if (file) await compose(['down', '-v', '--remove-orphans']);
});

describe('agent control channel through Caddy mTLS (M5 exit gate)', () => {
  it('enrolls, heartbeats, answers a signed task, rotates, and is revoked', async () => {
    const email = `agent-e2e-${Date.now()}@example.com`;
    expect((await api('POST', '/api/v1/auth/signup', { email, password: 'agent e2e password' })).status).toBe(
      202,
    );
    const token = await until('verification email', async () => {
      const list = (await (await fetch(`http://127.0.0.1:${MAILPIT_PORT}/api/v1/messages`)).json()) as {
        messages: Array<{ ID: string; To: Array<{ Address: string }> }>;
      };
      const hit = list.messages.find((m) => m.To[0]?.Address === email);
      if (!hit) return undefined;
      const full = (await (
        await fetch(`http://127.0.0.1:${MAILPIT_PORT}/api/v1/message/${hit.ID}`)
      ).json()) as { Text: string };
      return /token=([A-Za-z0-9_-]+)/.exec(full.Text)?.[1];
    });
    expect((await api('POST', '/api/v1/auth/verify', { token })).status).toBe(204);
    expect((await api('POST', '/api/v1/auth/login', { email, password: 'agent e2e password' })).status).toBe(
      200,
    );
    const org = await api('POST', '/api/v1/organizations', { name: 'Agent E2E', timezone: 'UTC' });
    const { secret } = (await api('POST', '/api/v1/auth/mfa/enroll', {})).json;
    expect((await api('POST', '/api/v1/auth/mfa/verify', { code: totp(secret) })).status).toBe(200);
    const product = await api('POST', `/api/v1/organizations/${org.json.id}/products`, { name: 'E2E' });
    const env = await api('POST', `/api/v1/products/${product.json.id}/environments`, { name: 'production' });
    const enrollment = await api('POST', `/api/v1/environments/${env.json.id}/agent-enrollments`, {});
    expect(enrollment.status).toBe(201);
    expect(enrollment.json.installCommand).toContain('--control-url https://agent.localhost');

    const ca = await compose([
      'cp',
      'caddy:/data/caddy/pki/authorities/local/root.crt',
      join(work, 'caddy-root.crt'),
    ]);
    expect(ca.status, ca.stderr).toBe(0);

    const goRun = run(
      'scripts/go.sh',
      ['test', '-count=1', '-run', 'TestLiveControlFlow', '-v', './agents/host-agent-go/internal/control'],
      {
        GO_DOCKER_NETWORK: `${PROJECT}_edge`,
        PCP_CONTROL_URL: `https://${SUBNET}.10`,
        PCP_SERVER_NAME: 'agent.localhost',
        PCP_SERVER_CA: `/src/${join(work, 'caddy-root.crt').slice(repoRoot.length)}`,
        PCP_ENROLL_TOKEN: enrollment.json.token,
      },
    );

    const agent = await until('agent to enroll and heartbeat', async () => {
      const agents = (await api('GET', `/api/v1/products/${product.json.id}/agents`)).json
        .agents as Array<Json>;
      return agents.find((a) => a.lastHeartbeatAt);
    });
    expect(agent).toMatchObject({ hostname: 'e2e-host', status: 'active', environmentName: 'production' });
    const before = (await api('GET', `/api/v1/agents/${agent.id}`)).json.certificate.fingerprintSha256;

    expect((await api('POST', `/api/v1/agents/${agent.id}/diagnostics`, {})).status).toBe(202);
    const task = await until('task result', async () => {
      const tasks = (await api('GET', `/api/v1/agents/${agent.id}/tasks`)).json.tasks as Array<Json>;
      return tasks.find((t) => t.status === 'succeeded');
    });
    expect(task.result).toEqual({ hostname: 'e2e-host', agentId: agent.id });

    await until('certificate rotation', async () => {
      const fp = (await api('GET', `/api/v1/agents/${agent.id}`)).json.certificate.fingerprintSha256;
      return fp !== before ? fp : undefined;
    });
    expect((await api('POST', `/api/v1/agents/${agent.id}/revoke`, {})).json).toEqual({ status: 'revoked' });

    const result = await goRun;
    writeFileSync(join(work, 'go-test.log'), result.stdout + result.stderr);
    expect(result.status, result.stdout.slice(-3000) + result.stderr.slice(-2000)).toBe(0);
    expect(result.stdout).toContain('--- PASS: TestLiveControlFlow');
  });
});
