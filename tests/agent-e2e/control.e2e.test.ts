import { createHmac } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sealCredentials } from '../../apps/web/lib/seal.js';
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
const HOST = 'pcp-install-e2e-host';
const CADDY = `${SUBNET}.10`;
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
    // No content type without a body: Fastify rejects an empty JSON body (the web client sends none either).
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      origin: ORIGIN,
      ...(cookie ? { cookie } : {}),
    },
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
  const up = await compose(['up', '-d', '--build', '--wait', '--wait-timeout', '1700']);
  if (up.status !== 0) throw new Error(`compose up failed: ${up.stderr.slice(-4000)}`);
  const ca = await compose([
    'cp',
    'caddy:/data/caddy/pki/authorities/local/root.crt',
    join(work, 'caddy-root.crt'),
  ]);
  if (ca.status !== 0) throw new Error(`copy Caddy root failed: ${ca.stderr}`);
  await setupOwner();
});

afterAll(async () => {
  await run('docker', ['rm', '-f', HOST]);
  if (file) await compose(['down', '-v', '--remove-orphans']);
});

let productId = '';
let environmentId = '';

/** Owner with MFA, product "E2E", and environment "production" (sets the session cookie). */
async function setupOwner() {
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
  expect(product.status).toBe(201);
  productId = product.json.id;
  const env = await api('POST', `/api/v1/products/${productId}/environments`, { name: 'production' });
  expect(env.status).toBe(201);
  environmentId = env.json.id;
}

async function enrollmentToken(): Promise<{ token: string; installCommand: string }> {
  const e = await api('POST', `/api/v1/environments/${environmentId}/agent-enrollments`, {});
  expect(e.status).toBe(201);
  return e.json as { token: string; installCommand: string };
}

describe('agent control channel through Caddy mTLS (M5 exit gate)', () => {
  it('enrolls, heartbeats, answers a signed task, rotates, and is revoked', async () => {
    const enrollment = { json: await enrollmentToken() };
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
      const agents = (await api('GET', `/api/v1/products/${productId}/agents`)).json.agents as Array<Json>;
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

const inHost = (script: string) => run('docker', ['exec', HOST, 'bash', '-c', script]);

describe('install.sh on a systemd host (M6a exit gate)', () => {
  it('installs, enrolls, and ships host metrics; upgrades in place; uninstalls cleanly', async () => {
    const image = await run('docker', [
      'build',
      '-q',
      '-t',
      'pcp-systemd-ubuntu:24.04',
      '-f',
      'tests/agent-e2e/systemd-ubuntu.Dockerfile',
      'tests/agent-e2e',
    ]);
    expect(image.status, image.stderr).toBe(0);
    await run('docker', ['rm', '-f', HOST]);
    const started = await run('docker', [
      'run',
      '-d',
      '--name',
      HOST,
      '--hostname',
      'install-host',
      '--privileged',
      '--cgroupns=host',
      '-v',
      '/sys/fs/cgroup:/sys/fs/cgroup:rw',
      '--network',
      `${PROJECT}_edge`,
      '--add-host',
      `agent.localhost:${CADDY}`,
      '--add-host',
      `ingest.localhost:${CADDY}`,
      'pcp-systemd-ubuntu:24.04',
    ]);
    expect(started.status, started.stderr).toBe(0);
    await until('systemd in the test host', async () =>
      (
        await inHost(
          'systemctl is-system-running --wait >/dev/null 2>&1; systemctl list-units >/dev/null && echo ok',
        )
      ).stdout.includes('ok')
        ? true
        : undefined,
    );
    expect(
      (await run('docker', ['cp', join(work, 'caddy-root.crt'), `${HOST}:/root/caddy-root.crt`])).status,
    ).toBe(0);
    const listenersBefore = (await inHost("ss -ltnH | awk '{print $4}' | sort")).stdout;
    const installer = `curl -fsSL http://${CADDY}/install.sh | bash -s --`;
    const devFlags = `--control-url https://agent.localhost --download-url http://${CADDY}/downloads --ca-file /root/caddy-root.crt`;

    // A tampered tarball must abort before anything is installed.
    const tampered = await inHost(`set -e; mkdir -p /tmp/bad; cd /tmp/bad;
      for f in VERSION SHA256SUMS; do curl -fsSL http://${CADDY}/downloads/$f -o $f; done;
      t=pcp-agent-$(cat VERSION)-linux-$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz;
      curl -fsSL http://${CADDY}/downloads/$t -o $t; printf x >> $t;
      ${installer} --token x --control-url https://agent.localhost --download-url file:///tmp/bad`);
    expect(tampered.status).not.toBe(0);
    expect(tampered.stderr).toContain('checksum mismatch');
    expect(
      (
        await inHost(
          'test -e /usr/local/bin/pcp-agentctl || test -e /etc/systemd/system/pcp-agent.service; echo $?',
        )
      ).stdout.trim(),
    ).toBe('1');

    const { token, installCommand } = await enrollmentToken();
    expect(installCommand).toContain(`--download-url`);
    const t0 = Date.now();
    const install = await inHost(`${installer} --token ${token} ${devFlags}`);
    expect(install.status, install.stdout + install.stderr).toBe(0);
    expect((await inHost('systemctl is-active pcp-agent')).stdout.trim()).toBe('active');
    expect((await inHost('stat -c %U:%a /var/lib/pcp-agent')).stdout.trim()).toBe('pcp-agent:700');

    // TC-04-01: host metrics are queryable through the API.
    const host = await until(
      'host metrics in the dashboard API',
      async () => {
        const hosts = (await api('GET', `/api/v1/products/${productId}/infrastructure`)).json.hosts as Json[];
        return hosts.find((h) => h.hostname === 'install-host' && h.cpuPercent !== null);
      },
      180_000,
    );
    const seconds = Math.round((Date.now() - t0) / 1000);
    writeFileSync(join(work, 'install-timing.txt'), `metrics visible ${seconds}s after install started\n`);
    expect(host.memoryPercent).not.toBeNull();
    const metrics = await api('GET', `/api/v1/agents/${host.agentId}/metrics?range=15m`);
    expect((metrics.json.series.cpu as Array<[number, number | null]>).some(([, v]) => v !== null)).toBe(
      true,
    );

    // No new non-loopback listener (outbound-only agent).
    const listenersAfter = (await inHost("ss -ltnH | awk '{print $4}' | sort")).stdout
      .split('\n')
      .filter(Boolean);
    const added = listenersAfter.filter((l) => !listenersBefore.includes(l));
    expect(added.filter((l) => !l.startsWith('127.0.0.1:') && !l.startsWith('[::1]:'))).toEqual([]);

    // Review Focus #5: re-running upgrades without re-enrolling.
    const before = JSON.parse((await inHost('cat /var/lib/pcp-agent/state.json')).stdout).agentId;
    const rerun = await inHost(`${installer} ${devFlags}`);
    expect(rerun.status, rerun.stderr).toBe(0);
    expect(rerun.stdout).toContain('already enrolled');
    expect(JSON.parse((await inHost('cat /var/lib/pcp-agent/state.json')).stdout).agentId).toBe(before);

    const removed = await inHost(`${installer} --uninstall`);
    expect(removed.status, removed.stderr).toBe(0);
    expect(
      (
        await inHost(
          'id pcp-agent >/dev/null 2>&1; echo $?; test -e /var/lib/pcp-agent; echo $?; test -e /etc/systemd/system/pcp-agent.service; echo $?',
        )
      ).stdout
        .split('\n')
        .filter(Boolean),
    ).toEqual(['1', '1', '1']);
  });
});

describe('service discovery and monitoring packs (M6b exit gate)', () => {
  it('discovers Redis and PostgreSQL, applies both packs with sealed credentials, and charts them', async () => {
    // Reuses the systemd host from the install test (tests in this file run in order).
    const installer = `curl -fsSL http://${CADDY}/install.sh | bash -s --`;
    const devFlags = `--control-url https://agent.localhost --download-url http://${CADDY}/downloads --ca-file /root/caddy-root.crt`;
    const pgPassword = 'monitor-e2e-secret';
    const db = await inHost(
      `systemctl is-active redis-server postgresql && runuser -u postgres -- psql -qc "CREATE USER pcp_monitor PASSWORD '${pgPassword}' IN ROLE pg_monitor"`,
    );
    expect(db.status, db.stdout + db.stderr).toBe(0);
    const { token } = await enrollmentToken();
    const install = await inHost(`${installer} --token ${token} ${devFlags}`);
    expect(install.status, install.stdout + install.stderr).toBe(0);
    const agentId = JSON.parse((await inHost('cat /var/lib/pcp-agent/state.json')).stdout).agentId as string;

    // Discovery: both services on loopback, no exposure warning.
    const inventory = await until('inventory with Redis and PostgreSQL', async () => {
      const inv = (await api('GET', `/api/v1/agents/${agentId}/inventory`)).json;
      const packs = ((inv.inventory?.services ?? []) as Json[]).map((s) => s.pack);
      return packs.includes('redis') && packs.includes('postgresql') ? inv : undefined;
    });
    expect(inventory.inventory.warnings).toEqual([]);
    expect(inventory.suggestedPacks).toEqual(expect.arrayContaining(['redis', 'postgresql']));

    // Enable both; PostgreSQL credentials are sealed as the dashboard does.
    const agent = (await api('GET', `/api/v1/agents/${agentId}`)).json;
    const sealed = await sealCredentials(agent.x25519PublicKey, {
      username: 'pcp_monitor',
      password: pgPassword,
    });
    expect(
      (
        await api('POST', `/api/v1/agents/${agentId}/packs`, {
          packId: 'redis',
          settings: { endpoint: '127.0.0.1:6379' },
        })
      ).status,
    ).toBe(201);
    const pg = await api('POST', `/api/v1/agents/${agentId}/packs`, {
      packId: 'postgresql',
      settings: { endpoint: '127.0.0.1:5432' },
      sealedCredentials: sealed,
    });
    expect(pg.status, JSON.stringify(pg.json)).toBe(201);

    const t0 = Date.now();
    const packs = await until(
      'both packs applied',
      async () => {
        const list = (await api('GET', `/api/v1/agents/${agentId}/packs`)).json.packs as Json[];
        const failed = list.find((p) => p.status === 'failed');
        if (failed) throw new Error(`pack failed: ${failed.packId}: ${failed.statusMessage}`);
        return list.length === 2 && list.every((p) => p.status === 'applied') ? list : undefined;
      },
      120_000,
    );
    expect(packs.map((p) => p.packId).sort()).toEqual(['postgresql', 'redis']);

    // Review Focus #1: the ciphertext is gone once the agent acknowledged; the password is nowhere.
    const rows = await compose([
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'postgres',
      '-d',
      'pcp',
      '-tAc',
      `SELECT count(*) FROM agent_pack_assignments WHERE agent_id = '${agentId}' AND sealed_credentials IS NOT NULL`,
    ]);
    expect(rows.stdout.trim(), rows.stderr).toBe('0');
    expect(
      (await inHost('stat -c %a /var/lib/pcp-agent/packs.json /var/lib/pcp-agent/collector.yaml')).stdout
        .trim()
        .split('\n'),
    ).toEqual(['600', '600']);

    // Charts: the fixed PromQL templates find real series (metric names verified here).
    const chartHasData = (body: Json, key: string) =>
      ((body.charts as Json[]).find((c) => c.key === key)?.series as Json[] | undefined)?.some((s) =>
        (s.points as Array<[number, number | null]>).some(([, v]) => v !== null),
      );
    const redis = await until(
      'Redis charts',
      async () => {
        const body = (await api('GET', `/api/v1/agents/${agentId}/services/redis/metrics?range=15m`)).json;
        return chartHasData(body, 'memory') && chartHasData(body, 'clients') ? body : undefined;
      },
      180_000,
    );
    const postgres = await until(
      'PostgreSQL charts',
      async () => {
        const body = (await api('GET', `/api/v1/agents/${agentId}/services/postgresql/metrics?range=15m`))
          .json;
        return chartHasData(body, 'connections') && chartHasData(body, 'size') ? body : undefined;
      },
      180_000,
    );
    writeFileSync(
      join(work, 'packs-timing.txt'),
      `service metrics visible ${Math.round((Date.now() - t0) / 1000)}s after enabling\n`,
    );
    expect(redis.status).toBe('applied');
    expect(postgres.status).toBe('applied');

    // Disabling removes the receiver; the assignment disappears after the agent acknowledges.
    expect((await api('DELETE', `/api/v1/agents/${agentId}/packs/redis`)).status).toBe(202);
    await until('redis pack removed', async () => {
      const list = (await api('GET', `/api/v1/agents/${agentId}/packs`)).json.packs as Json[];
      return list.some((p) => p.packId === 'redis') ? undefined : true;
    });
    expect(
      (await inHost('grep -c \'"redis"\' /var/lib/pcp-agent/collector.yaml || true')).stdout.trim(),
    ).toBe('0');
  });
});
