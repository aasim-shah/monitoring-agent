// M19.2 load baselines on a local Compose stack (never the shared VPS).
//   node tests/load/run.ts            → writes tests/load/results/*.json
// Starts the stack with the e2e override (Mailpit), creates an owner with MFA and one product,
// runs the k6 API script, then tears the stack down.
import { createHmac } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SECRETS, compose as composeRun, envFile, repoRoot, run } from '../smoke/compose.ts';

const PROJECT = 'pcp-load';
const HTTP_PORT = 18097;
const MAILPIT_PORT = 18247;
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const ORIGIN = `http://localhost:${HTTP_PORT}`;
const out = join(repoRoot, 'tests/load/results');
mkdirSync(out, { recursive: true });
const file = envFile({
  ...SECRETS,
  CADDY_CONFIG: 'Caddyfile.local',
  APP_ORIGIN: ORIGIN,
  HTTP_PORT: String(HTTP_PORT),
  HTTPS_PORT: String(HTTP_PORT + 400),
  MAILPIT_PORT: String(MAILPIT_PORT),
  EDGE_SUBNET: '172.31.9.0/24',
  CADDY_ADDRESS: '172.31.9.10',
});
const compose = (args: string[]) => composeRun(PROJECT, file, ['-f', 'tests/e2e/compose.e2e.yaml', ...args]);

let cookie = '';
async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      origin: ORIGIN,
      ...(cookie ? { cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const set = res.headers.get('set-cookie');
  if (set?.startsWith('pcp_session=')) cookie = set.split(';')[0]!;
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : {}) as Record<string, any> };
}

function totp(secret: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret.replace(/=+$/, '')) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = createHmac('sha1', key).update(counter).digest();
  const o = h[h.length - 1]! & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

async function owner() {
  const email = `load-${Date.now()}@example.com`;
  await api('POST', '/api/v1/auth/signup', { email, password: 'load test password' });
  let token: string | undefined;
  for (let i = 0; i < 60 && !token; i++) {
    const list = (await (await fetch(`http://127.0.0.1:${MAILPIT_PORT}/api/v1/messages`)).json()) as {
      messages: Array<{ ID: string; To: Array<{ Address: string }> }>;
    };
    const hit = list.messages.find((m) => m.To[0]?.Address === email);
    if (hit) {
      const full = (await (
        await fetch(`http://127.0.0.1:${MAILPIT_PORT}/api/v1/message/${hit.ID}`)
      ).json()) as { Text: string };
      token = /token=([A-Za-z0-9_-]+)/.exec(full.Text)?.[1];
    } else await new Promise((r) => setTimeout(r, 1000));
  }
  await api('POST', '/api/v1/auth/verify', { token });
  await api('POST', '/api/v1/auth/login', { email, password: 'load test password' });
  const org = await api('POST', '/api/v1/organizations', { name: 'Load', timezone: 'UTC' });
  const { secret } = (await api('POST', '/api/v1/auth/mfa/enroll', {})).json;
  await api('POST', '/api/v1/auth/mfa/verify', { code: totp(secret) });
  const product = await api('POST', `/api/v1/organizations/${org.json.id}/products`, { name: 'Load' });
  return product.json.id as string;
}

try {
  const up = await compose(['up', '-d', '--build', '--wait', '--wait-timeout', '1700']);
  if (up.status !== 0) throw new Error(up.stderr.slice(-3000));
  const productId = await owner();
  const k6 = await run('docker', [
    'run',
    '--rm',
    '--add-host',
    'host.docker.internal:host-gateway',
    '-e',
    `BASE=http://host.docker.internal:${HTTP_PORT}`,
    '-e',
    `COOKIE=${cookie}`,
    '-e',
    `PRODUCT_ID=${productId}`,
    '-v',
    `${join(repoRoot, 'tests/load')}:/load`,
    'grafana/k6:0.57.0',
    'run',
    '--summary-export',
    '/load/results/api.json',
    '/load/api.js',
  ]);
  writeFileSync(join(out, 'api.log'), k6.stdout + k6.stderr);
  console.log(
    k6.stdout
      .split('\n')
      .filter((l) => /http_req_duration|http_reqs|checks|iterations/.test(l))
      .join('\n'),
  );
  if (k6.status !== 0) process.exitCode = 1;
} finally {
  await compose(['down', '-v', '--remove-orphans']);
}
