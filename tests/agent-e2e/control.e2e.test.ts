import { createHmac } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sealCredentials } from '../../apps/web/lib/seal.js';
import { SECRETS, compose as composeRun, envFile, repoRoot, run } from '../smoke/compose.js';
import { assertFreeDisk } from '../disk-guard.js';

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
  assertFreeDisk();
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
  await run('docker', ['rm', '-f', HOST, ...FLEET, COMPOSE_AGENT, ...ASSISTED]);
  if (file) await compose(['down', '-v', '--remove-orphans']);
});

let orgId = '';
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
  orgId = org.json.id as string;
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
const FLEET = ['pcp-fleet-1', 'pcp-fleet-2', 'pcp-fleet-3'];
const COMPOSE_AGENT = 'pcp-compose-agent';
const ASSISTED = ['pcp-assisted-1', 'pcp-assisted-2'];

/** A disposable systemd host on the edge network that resolves the dev hostnames to Caddy. */
async function systemdHost(name: string, hostname: string) {
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
  await run('docker', ['rm', '-f', name]);
  const started = await run('docker', [
    'run',
    '-d',
    '--name',
    name,
    '--hostname',
    hostname,
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
  await until(`systemd in ${name}`, async () =>
    (
      await run('docker', [
        'exec',
        name,
        'bash',
        '-c',
        'systemctl is-system-running --wait >/dev/null 2>&1; systemctl list-units >/dev/null && echo ok',
      ])
    ).stdout.includes('ok')
      ? true
      : undefined,
  );
  expect(
    (await run('docker', ['cp', join(work, 'caddy-root.crt'), `${name}:/root/caddy-root.crt`])).status,
  ).toBe(0);
}

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

    // M10: every config drops per-request labels at the edge (spec §11.6).
    expect(
      (await inHost('grep -c transform/drop_labels /var/lib/pcp-agent/collector.yaml')).stdout.trim(),
    ).not.toBe('0');
    // M10.7 live boost: the signed task sets Redis to 5 s on the host (BR-11-08).
    const boost = await api('POST', `/api/v1/agents/${agentId}/live-boost`, { packId: 'redis' });
    expect(boost.status, JSON.stringify(boost.json)).toBe(202);
    await until(
      'redis boosted to 5 s on the host',
      async () =>
        (
          await inHost(`grep -A3 '"redis": {' /var/lib/pcp-agent/collector.yaml | grep -c '"5s"' || true`)
        ).stdout.trim() !== '0'
          ? true
          : undefined,
      90_000,
    );

    // M18.2 data inspection: off until the owner turns it on, then stats and the allowlisted key's
    // length from the real Redis, and no value leaves the host (TC-12-06).
    await inHost(
      'redis-cli DEL jobs >/dev/null; redis-cli RPUSH jobs secret-payload-a secret-payload-b secret-payload-c >/dev/null',
    );
    const inspectUrl = `/api/v1/agents/${agentId}/inspections`;
    expect((await api('POST', inspectUrl, { packId: 'redis', target: 'redis' })).json.code).toBe(
      'inspection_disabled',
    );
    expect(
      (
        await api('PATCH', `/api/v1/agents/${agentId}/packs/redis/inspection`, {
          enabled: true,
          redisKeys: ['jobs'],
        })
      ).status,
    ).toBe(200);
    const inspection = await api('POST', inspectUrl, { packId: 'redis', target: 'redis' });
    expect(inspection.status, JSON.stringify(inspection.json)).toBe(202);
    const inspected = await until('redis inspection', async () => {
      const r = (await api('GET', `/api/v1/inspections/${inspection.json.id}`)).json;
      if (r.status === 'failed') throw new Error(`inspection failed: ${r.error}`);
      return r.status === 'succeeded' ? r : undefined;
    });
    expect(inspected.result.dbSize).toBeGreaterThanOrEqual(1);
    expect(inspected.result.keys).toEqual([
      expect.objectContaining({ key: 'jobs', type: 'list', length: 3 }),
    ]);
    expect(JSON.stringify(inspected)).not.toContain('secret-payload');

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

describe('private connector worker (M8 exit gate)', () => {
  it('reports MongoDB health for a FireMaps-like database through the private worker', async () => {
    const MONGO = 'pcp-e2e-firemaps-mongo';
    const WORKER = 'pcp-e2e-private-worker';
    const password = 'firemaps-monitor-e2e-secret';
    const built = await run('docker', [
      'build',
      '-q',
      '-t',
      'pcp-private-worker:e2e',
      '-f',
      'agents/private-connector-worker/Dockerfile',
      '.',
    ]);
    expect(built.status, built.stderr).toBe(0);
    await run('docker', ['rm', '-f', MONGO, WORKER]);
    const mongo = await run('docker', [
      'run',
      '-d',
      '--name',
      MONGO,
      '--network',
      `${PROJECT}_edge`,
      '-e',
      'MONGO_INITDB_ROOT_USERNAME=root',
      '-e',
      'MONGO_INITDB_ROOT_PASSWORD=root',
      'mongo:8.0',
    ]);
    expect(mongo.status, mongo.stderr).toBe(0);
    const mongosh = (js: string) =>
      run('docker', [
        'exec',
        MONGO,
        'mongosh',
        '--quiet',
        '-u',
        'root',
        '-p',
        'root',
        '--authenticationDatabase',
        'admin',
        '--eval',
        js,
      ]);
    await until('MongoDB', async () =>
      (await mongosh('db.runCommand({ ping: 1 }).ok')).stdout.trim() === '1' ? true : undefined,
    );
    const fixture = await mongosh(`
      const fm = db.getSiblingDB('firemaps');
      fm.incidents.insertMany(Array.from({ length: 500 }, (_, i) => ({ createdAt: new Date(Date.now() - (i % 7) * 864e5), severity: i % 3 })));
      fm.stations.insertMany([{ name: 'North' }, { name: 'South' }]);
      db.getSiblingDB('admin').createUser({ user: 'pcp_monitor', pwd: '${password}',
        roles: [{ role: 'read', db: 'firemaps' }, { role: 'clusterMonitor', db: 'admin' }] });
      print('ok');`);
    expect(fixture.stdout, fixture.stderr).toContain('ok');

    // The credentials exist only in the worker's secret file.
    const secrets = join(work, 'worker-secrets');
    mkdirSync(secrets, { recursive: true });
    writeFileSync(join(secrets, 'firemaps-mongo.yaml'), `username: pcp_monitor\npassword: ${password}\n`);
    chmodSync(secrets, 0o755);
    chmodSync(join(secrets, 'firemaps-mongo.yaml'), 0o644);
    chmodSync(join(work, 'caddy-root.crt'), 0o644);

    const e = await api('POST', `/api/v1/environments/${environmentId}/agent-enrollments`, {
      agentType: 'private_worker',
    });
    expect(e.status).toBe(201);
    expect(e.json.installCommand).toContain('enroll-and-run');
    const worker = await run('docker', [
      'run',
      '-d',
      '--name',
      WORKER,
      '--network',
      `${PROJECT}_edge`,
      '--add-host',
      `agent.localhost:${CADDY}`,
      '-v',
      `${secrets}:/etc/pcp-worker/secrets:ro`,
      '-v',
      `${join(work, 'caddy-root.crt')}:/etc/pcp-worker/caddy-root.crt:ro`,
      'pcp-private-worker:e2e',
      'enroll-and-run',
      '--token',
      e.json.token,
      '--control-url',
      'https://agent.localhost',
      '--ca-file',
      '/etc/pcp-worker/caddy-root.crt',
    ]);
    expect(worker.status, worker.stderr).toBe(0);
    const workerAgent = await until('private worker enrolled', async () => {
      const agents = (await api('GET', `/api/v1/products/${productId}/agents`)).json.agents as Json[];
      return agents.find((a) => a.agentType === 'private_worker');
    });

    const created = await api('POST', `/api/v1/organizations/${orgId}/connections`, {
      provider: 'mongodb',
      displayName: 'FireMaps',
      executionLocation: 'private',
      config: {
        workerAgentId: workerAgent.id,
        secretRef: 'firemaps-mongo',
        host: MONGO,
        port: 27017,
        database: 'firemaps',
        tls: false,
        allowInsecure: true,
      },
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const id = created.json.id as string;

    const connected = await until(
      'MongoDB connection validated by the worker',
      async () => {
        const c = (await api('GET', `/api/v1/connections/${id}`)).json;
        if (c.status === 'degraded') throw new Error(`validation failed: ${c.statusReason}`);
        return c.status === 'connected' ? c : undefined;
      },
      180_000,
    );
    expect(connected.statusReason).toBeNull();
    const health = await until('MongoDB health', async () => {
      const h = (await api('GET', `/api/v1/connections/${id}/health`)).json;
      return h.latest?.ok ? h.latest : undefined;
    });
    expect(health.data).toMatchObject({
      engine: 'mongodb',
      connections: expect.any(Number),
      database: { name: 'firemaps', collections: 2, objects: 502 },
    });

    // WB-07 acceptance 3: no database credential in the control-plane database.
    const dump = await compose(['exec', '-T', 'postgres', 'pg_dump', '-U', 'postgres', '-d', 'pcp']);
    expect(dump.status, dump.stderr).toBe(0);
    expect(dump.stdout).toContain('firemaps-mongo');
    expect(dump.stdout).not.toContain(password);
    await run('docker', ['rm', '-f', MONGO, WORKER]);
  });
});

/** An SSE connection to the live tail through Caddy; collects `event`/`data` pairs. */
async function openTail(agentId: string, source: string) {
  const ctrl = new AbortController();
  const res = await fetch(`${BASE}/api/v1/agents/${agentId}/logs/tail?source=${source}`, {
    headers: { cookie, origin: ORIGIN, accept: 'text/event-stream' },
    signal: ctrl.signal,
  });
  const events: Array<{ event: string; data: Json }> = [];
  const pump = (async () => {
    let text = '';
    try {
      for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
        text += Buffer.from(part).toString('utf8');
        let cut: number;
        while ((cut = text.indexOf('\n\n')) >= 0) {
          const block = text.slice(0, cut);
          text = text.slice(cut + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (event) events.push({ event, data: data ? JSON.parse(data) : {} });
        }
      }
    } catch {
      // aborted
    }
  })();
  const lines = () => events.filter((e) => e.event === 'lines').flatMap((e) => e.data.lines as string[]);
  return {
    res,
    events,
    lines,
    sessionId: async () =>
      (await until('ready event', async () => events.find((e) => e.event === 'ready'))).data
        .sessionId as string,
    close: async () => {
      ctrl.abort();
      await pump;
    },
  };
}

describe('live log tail and log-derived metrics (M11 exit gate)', () => {
  it('tails Redis and the journal masked on the host, stops on close, and counts error lines', async () => {
    // Reuses the systemd host and agent from the packs test; the Redis pack was disabled there.
    const agentId = JSON.parse((await inHost('cat /var/lib/pcp-agent/state.json')).stdout).agentId as string;
    expect((await inHost('id -nG pcp-agent')).stdout).toMatch(/\badm\b/);
    expect(
      (
        await api('POST', `/api/v1/agents/${agentId}/packs`, {
          packId: 'redis',
          settings: { endpoint: '127.0.0.1:6379' },
        })
      ).status,
    ).toBe(201);
    await until('redis pack applied', async () => {
      const list = (await api('GET', `/api/v1/agents/${agentId}/packs`)).json.packs as Json[];
      return list.find((p) => p.packId === 'redis' && p.status === 'applied');
    });
    const sources = (await api('GET', `/api/v1/agents/${agentId}/log-sources`)).json.sources as Json[];
    expect(sources.map((s) => s.id)).toEqual(['redis.server', 'postgresql.main', 'host.journal']);

    // UC-12-01/02: a new Redis log line arrives masked.
    const tail = await openTail(agentId, 'redis.server');
    expect(tail.res.status).toBe(200);
    const sessionId = await tail.sessionId();
    await new Promise((r) => setTimeout(r, 3000)); // the agent picks the task up and seeks to the end
    const log = '/var/log/redis/redis-server.log';
    expect(
      (
        await inHost(
          `echo "1:M 23 Oct 2026 10:00:00.000 * pcp-e2e login password=hunter2 by ops@example.com" >> ${log}`,
        )
      ).status,
    ).toBe(0);
    const line = await until(
      'redacted Redis line',
      async () => tail.lines().find((l) => l.includes('pcp-e2e login')),
      60_000,
    );
    expect(line).toContain('password=[REDACTED]');
    expect(line).toContain('[EMAIL]');
    expect(line).not.toContain('hunter2');
    expect(line).not.toContain('ops@example.com');

    // Review Focus #3: closing the stream closes the session and the agent stops its tail.
    await tail.close();
    const sql = (q: string) =>
      compose(['exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'pcp', '-tAc', q]);
    await until('session closed', async () =>
      (await sql(`SELECT status FROM agent_stream_sessions WHERE id = '${sessionId}'`)).stdout.trim() ===
      'closed'
        ? true
        : undefined,
    );
    await until(
      'log_tail task finished',
      async () => {
        const status = (
          await sql(`SELECT status FROM agent_tasks WHERE payload->>'sessionId' = '${sessionId}'`)
        ).stdout.trim();
        return status === 'succeeded' ? true : undefined;
      },
      60_000,
    );

    // The system journal is always available.
    const journal = await openTail(agentId, 'host.journal');
    await journal.sessionId();
    await new Promise((r) => setTimeout(r, 3000));
    await inHost(`logger "pcp-e2e journal token=abc123secret"`);
    const jline = await until(
      'journal line',
      async () => journal.lines().find((l) => l.includes('pcp-e2e journal')),
      60_000,
    );
    expect(jline).toContain('token=[REDACTED]');
    await journal.close();

    // M11.2: error lines in the Redis log become log_lines_total{level="error"}.
    await inHost(
      `for i in 1 2 3; do echo "1:M 23 Oct 2026 10:00:0$i.000 # Error accepting a client connection: pcp-e2e $i" >> ${log}; done`,
    );
    await until(
      'log errors chart',
      async () => {
        const body = (await api('GET', `/api/v1/agents/${agentId}/services/redis/metrics?range=15m`)).json;
        const chart = (body.charts as Json[]).find((c) => c.key === 'logErrors');
        const values = ((chart?.series as Json[] | undefined) ?? []).flatMap((s) =>
          (s.points as Array<[number, number | null]>).map(([, v]) => v ?? 0),
        );
        return values.some((v) => v > 0) ? true : undefined;
      },
      240_000,
    );
  });
});

/** A second member (admin, with MFA) for approvals; returns their session cookie. */
async function adminMember(): Promise<string> {
  const ownerCookie = cookie;
  cookie = '';
  try {
    const email = `agent-e2e-admin-${Date.now()}@example.com`;
    expect((await api('POST', '/api/v1/auth/signup', { email, password: 'agent e2e password' })).status).toBe(
      202,
    );
    const token = await until('admin verification email', async () => {
      const list = (await (await fetch(`http://127.0.0.1:${MAILPIT_PORT}/api/v1/messages`)).json()) as {
        messages: Array<{ ID: string; To: Array<{ Address: string }> }>;
      };
      const hit = list.messages.find((m) => m.To[0]?.Address === email);
      if (!hit) return undefined;
      const full = (await (
        await fetch(`http://127.0.0.1:${MAILPIT_PORT}/api/v1/message/${hit.ID}`)
      ).json()) as {
        Text: string;
      };
      return /token=([A-Za-z0-9_-]+)/.exec(full.Text)?.[1];
    });
    expect((await api('POST', '/api/v1/auth/verify', { token })).status).toBe(204);
    const sql = (q: string) =>
      compose(['exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'pcp', '-tAc', q]);
    const added = await sql(
      `INSERT INTO organization_members (id, organization_id, user_id, role) SELECT gen_random_uuid(), '${orgId}', id, 'admin' FROM users WHERE email = '${email}'`,
    );
    expect(added.status, added.stderr).toBe(0);
    expect((await api('POST', '/api/v1/auth/login', { email, password: 'agent e2e password' })).status).toBe(
      200,
    );
    const { secret } = (await api('POST', '/api/v1/auth/mfa/enroll', {})).json;
    expect((await api('POST', '/api/v1/auth/mfa/verify', { code: totp(secret) })).status).toBe(200);
    return cookie;
  } finally {
    cookie = ownerCookie;
  }
}

async function asUser<T>(session: string, fn: () => Promise<T>): Promise<T> {
  const saved = cookie;
  cookie = session;
  try {
    return await fn();
  } finally {
    cookie = saved;
  }
}

describe('approved service restart through pcp-helper (M16 exit gate)', () => {
  it('restarts an allowlisted unit after another member approves, verifies it, and refuses units outside the host allowlist', async () => {
    // Reuses the enrolled systemd host; re-running the installer with --enable-helper adds pcp-helper.
    const installer = `curl -fsSL http://${CADDY}/install.sh | bash -s --`;
    const devFlags = `--control-url https://agent.localhost --download-url http://${CADDY}/downloads --ca-file /root/caddy-root.crt`;
    const install = await inHost(`${installer} ${devFlags} --enable-helper`);
    expect(install.status, install.stdout + install.stderr).toBe(0);
    expect((await inHost('systemctl is-active pcp-helper')).stdout.trim()).toBe('active');
    expect((await inHost('stat -c "%a %U %G" /run/pcp-helper/helper.sock')).stdout.trim()).toBe(
      '660 root pcp-agent',
    );
    expect(
      (
        await inHost('stat -c "%a %U" /etc/pcp-agent/task-signing.pub /etc/pcp-agent/helper.yaml')
      ).stdout.trim(),
    ).toBe('644 root\n644 root');
    // The host owner allowlists one unit; the platform cannot change this file.
    const unit = await inHost(
      `printf '[Unit]\\nDescription=pcp e2e demo\\n[Service]\\nExecStart=/bin/sleep infinity\\n[Install]\\nWantedBy=multi-user.target\\n' > /etc/systemd/system/demo.service && systemctl daemon-reload && systemctl enable --now demo.service && sed -i 's/units: \\[\\]/units: [demo.service]/' /etc/pcp-agent/helper.yaml && grep -c demo.service /etc/pcp-agent/helper.yaml`,
    );
    expect(unit.status, unit.stdout + unit.stderr).toBe(0);
    const agentId = JSON.parse((await inHost('cat /var/lib/pcp-agent/state.json')).stdout).agentId as string;
    await until('agent 0.4.0 reporting', async () => {
      const a = (await api('GET', `/api/v1/agents/${agentId}`)).json;
      return a.agentVersion === '0.4.0' ? true : undefined;
    });

    const admin = await adminMember();
    expect(
      (
        await api('PUT', `/api/v1/products/${productId}/action-policies/host.restart_service`, {
          environmentId,
          enabled: true,
          approverRoles: ['owner', 'admin'],
          requireApproval: true,
          settings: { units: ['demo.service', 'ghost.service'] },
        })
      ).status,
    ).toBe(200);
    const started = (
      await inHost('systemctl show -p ActiveEnterTimestampMonotonic --value demo.service')
    ).stdout.trim();

    const propose = (u: string) =>
      api('POST', '/api/v1/actions/proposals', {
        productId,
        environmentId,
        capability: 'host.restart_service',
        target: { agentId },
        params: { unit: u },
        idempotencyKey: `e2e-${u}-${Date.now()}`,
        reason: 'agent-e2e',
      });
    const req = (await propose('demo.service')).json;
    expect(req.status).toBe('pending_approval');
    // BR-16-03: the requester cannot approve their own production action.
    expect((await api('POST', `/api/v1/actions/${req.id}/approve`, {})).status).toBe(403);
    const approved = await asUser(admin, () =>
      api('POST', `/api/v1/actions/${req.id}/approve`, { note: 'e2e' }),
    );
    expect(approved.status, JSON.stringify(approved.json)).toBe(200);

    let last: Json = {};
    const done = await until(
      'restart verified',
      async () => {
        const r = (await api('GET', `/api/v1/actions/${req.id}`)).json;
        last = r;
        return ['succeeded', 'failed', 'expired'].includes(r.status as string) ? r : undefined;
      },
      180_000,
    ).catch(async (e: Error) => {
      // Say where it stopped: the request, its executions, and what the agent and helper logged.
      const logs = await inHost(
        'journalctl -u pcp-agent -u pcp-helper --no-pager -n 60 -o short-monotonic; systemctl is-active demo.service',
      );
      throw new Error(
        `${e.message}; last: ${JSON.stringify(last)}; host logs:\n${logs.stdout}${logs.stderr}`,
      );
    });
    expect(done.status, JSON.stringify(done)).toBe('succeeded');
    expect((done.executions as Json[])[0]!.verification).toEqual({ activeState: 'active', verified: true });
    const restarted = (
      await inHost('systemctl show -p ActiveEnterTimestampMonotonic --value demo.service')
    ).stdout.trim();
    expect(restarted).not.toBe(started);

    // TC-16-06: allowed by the platform policy but not by the host's own allowlist → the helper refuses.
    const ghost = (await propose('ghost.service')).json;
    await asUser(admin, () => api('POST', `/api/v1/actions/${ghost.id}/approve`, {}));
    const refused = await until(
      'helper refusal',
      async () => {
        const r = (await api('GET', `/api/v1/actions/${ghost.id}`)).json;
        return r.status === 'failed' ? r : undefined;
      },
      180_000,
    );
    expect(refused.reason).toBe('ghost.service is not in the helper allowlist (/etc/pcp-agent/helper.yaml)');
  });
});

describe('fleet tooling (M17.2 exit gate)', () => {
  it('TC-05-04: the Ansible role enrolls 3 hosts over SSH, and a second run changes nothing', async () => {
    await Promise.all(FLEET.map((name, i) => systemdHost(name, `fleet-${i + 1}`)));
    const keyFile = join(work, 'ansible_ed25519');
    const keygen = await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyFile]);
    expect(keygen.status, keygen.stderr).toBe(0);
    for (const name of FLEET) {
      expect((await run('docker', ['cp', `${keyFile}.pub`, `${name}:/root/ansible.pub`])).status).toBe(0);
      const ssh = await run('docker', [
        'exec',
        name,
        'bash',
        '-c',
        'install -d -m 700 /root/.ssh && cat /root/ansible.pub >> /root/.ssh/authorized_keys && systemctl start ssh',
      ]);
      expect(ssh.status, ssh.stderr).toBe(0);
    }
    const e = await api('POST', `/api/v1/environments/${environmentId}/agent-enrollments`, { maxUses: 3 });
    expect(e.status).toBe(201);
    const install = e.json.install as Json;
    mkdirSync(join(work, 'ansible'), { recursive: true });
    writeFileSync(
      join(work, 'ansible', 'inventory'),
      `[fleet]\n${FLEET.join('\n')}\n\n[fleet:vars]\nansible_user=root\nansible_ssh_private_key_file=/work/ansible_ed25519\nansible_ssh_common_args=-o StrictHostKeyChecking=no\nansible_python_interpreter=/usr/bin/python3\n`,
    );
    writeFileSync(join(work, 'ansible', 'vault.yml'), `vault_pcp_fleet_token: ${install.token}\n`);
    writeFileSync(
      join(work, 'ansible', 'site.yml'),
      [
        '- hosts: fleet',
        '  become: true',
        '  vars_files: [vault.yml]',
        '  roles:',
        '    - role: pcp_agent',
        '      pcp_agent_token: "{{ vault_pcp_fleet_token }}"',
        '      pcp_agent_control_url: https://agent.localhost',
        `      pcp_agent_download_url: http://${CADDY}/downloads`,
        "      pcp_agent_extra_args: ['--ca-file', '/root/caddy-root.crt']",
        '',
      ].join('\n'),
    );
    chmodSync(keyFile, 0o600);
    const controller = await run(
      'docker',
      ['build', '-q', '-t', 'pcp-ansible-controller', '-'],
      {},
      'FROM python:3.12.12-slim\nRUN apt-get update && apt-get install -y --no-install-recommends openssh-client && rm -rf /var/lib/apt/lists/* && pip install --no-cache-dir ansible-core==2.17.14\n',
    );
    expect(controller.status, controller.stderr).toBe(0);
    const playbook = () =>
      run('docker', [
        'run',
        '--rm',
        '--network',
        `${PROJECT}_edge`,
        '-v',
        `${work}:/work`,
        '-v',
        `${join(repoRoot, 'infrastructure/install/ansible/roles')}:/work/ansible/roles:ro`,
        '-w',
        '/work/ansible',
        '-e',
        'ANSIBLE_HOST_KEY_CHECKING=False',
        'pcp-ansible-controller',
        'ansible-playbook',
        '-i',
        'inventory',
        'site.yml',
      ]);
    const first = await playbook();
    writeFileSync(join(work, 'ansible-1.log'), first.stdout + first.stderr);
    expect(first.status, first.stdout.slice(-3000)).toBe(0);
    expect(first.stdout).not.toContain(install.token);
    const agents = await until('3 fleet agents', async () => {
      const list = (await api('GET', `/api/v1/products/${productId}/agents`)).json.agents as Json[];
      const fleet = list.filter((a) => /^fleet-\d$/.test(a.hostname) && a.lastHeartbeatAt);
      return fleet.length === 3 ? fleet : undefined;
    });
    expect(agents.map((a) => a.hostname).sort()).toEqual(['fleet-1', 'fleet-2', 'fleet-3']);
    const second = await playbook();
    writeFileSync(join(work, 'ansible-2.log'), second.stdout + second.stderr);
    expect(second.status, second.stdout.slice(-3000)).toBe(0);
    for (const name of FLEET) expect(second.stdout).toMatch(new RegExp(`${name}\\s+: ok=\\d+\\s+changed=0 `));
  });

  it('UC-05-04: the Compose agent image enrolls from a verified tarball and reads host metrics under /hostfs', async () => {
    const e = await api('POST', `/api/v1/environments/${environmentId}/agent-enrollments`, {});
    expect(e.status).toBe(201);
    const install = e.json.install as Json;
    // BuildKit can reach the published Caddy port only through the host network.
    const build = await run('docker', [
      'build',
      '-q',
      '--network',
      'host',
      '--build-arg',
      `PCP_DOWNLOAD_URL=http://127.0.0.1:${HTTP_PORT}/downloads`,
      '-t',
      'pcp-agent-compose:e2e',
      'infrastructure/install/compose-agent',
    ]);
    expect(build.status, build.stderr).toBe(0);
    // A fresh identity: a volume left by an earlier run holds a certificate from another stack's CA.
    await run('docker', ['rm', '-f', COMPOSE_AGENT]);
    await run('docker', ['volume', 'rm', '-f', 'pcp-compose-agent-state']);
    const started = await run('docker', [
      'run',
      '-d',
      '--name',
      COMPOSE_AGENT,
      '--hostname',
      'compose-host',
      '--network',
      `${PROJECT}_edge`,
      '--add-host',
      `agent.localhost:${CADDY}`,
      '--add-host',
      `ingest.localhost:${CADDY}`,
      '--pid',
      'host',
      '--read-only',
      '--tmpfs',
      '/tmp',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',
      '-v',
      '/:/hostfs:ro',
      '-v',
      `${join(work, 'caddy-root.crt')}:/etc/pcp-ca.crt:ro`,
      '-v',
      'pcp-compose-agent-state:/var/lib/pcp-agent',
      '-e',
      `PCP_TOKEN=${install.token}`,
      '-e',
      'PCP_CONTROL_URL=https://agent.localhost',
      '-e',
      'PCP_CA_FILE=/etc/pcp-ca.crt',
      '-e',
      'PCP_HOST_ROOT=/hostfs',
      'pcp-agent-compose:e2e',
    ]);
    expect(started.status, started.stderr).toBe(0);
    const host = await until(
      'compose agent host metrics',
      async () => {
        const hosts = (await api('GET', `/api/v1/products/${productId}/infrastructure`)).json.hosts as Json[];
        return hosts.find((h) => h.hostname === 'compose-host' && h.cpuPercent !== null);
      },
      180_000,
    ).catch(async (err) => {
      writeFileSync(join(work, 'compose-agent.log'), (await run('docker', ['logs', COMPOSE_AGENT])).stderr);
      throw err;
    });
    expect(host.memoryPercent).not.toBeNull();
    const config = await run('docker', ['exec', COMPOSE_AGENT, 'pcp-agentctl', 'collector-config']);
    expect(config.stdout).toMatch(/"root_path": *"\/hostfs"/);
    await run('docker', ['rm', '-f', COMPOSE_AGENT]);
    await run('docker', ['volume', 'rm', 'pcp-compose-agent-state']);
  });
});

describe('assisted SSH install (M17.3 exit gate)', () => {
  const inBox = (name: string, script: string) => run('docker', ['exec', name, 'bash', '-c', script]);
  /** The host reaches the app origin (localhost:HTTP_PORT) through Caddy and trusts Caddy's dev root. */
  async function target(name: string, hostname: string) {
    await systemdHost(name, hostname);
    const prep = await inBox(
      name,
      `cp /root/caddy-root.crt /usr/local/share/ca-certificates/pcp-dev.crt && update-ca-certificates >/dev/null &&
       systemd-run --unit pcp-origin socat TCP-LISTEN:${HTTP_PORT},fork,reuseaddr,bind=127.0.0.1 TCP:${CADDY}:80 &&
       systemctl start ssh`,
    );
    expect(prep.status, prep.stderr).toBe(0);
  }
  const session = async (id: string) => (await api('GET', `/api/v1/install-sessions/${id}`)).json;
  const hostIs = (id: string, status: string) =>
    until(
      `install host ${status}`,
      async () => {
        const s = await session(id);
        const h = (s.hosts as Json[])[0]!;
        if (h.status === 'failed' && status !== 'failed')
          throw new Error(`host failed: ${h.error}\n${h.output}`);
        return h.status === status && (status !== 'installed' || h.cleanup) ? s : undefined;
      },
      300_000,
    );

  it('TC-05-06/07: installs after the fingerprint is confirmed, then removes the pcp-install user and key', async () => {
    await target(ASSISTED[0]!, 'assisted-1');
    const created = await api('POST', `/api/v1/environments/${environmentId}/install-sessions`, {
      mode: 'key',
      hosts: [{ host: ASSISTED[0] }],
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const s = created.json;
    const setup = await inBox(ASSISTED[0]!, s.setupCommand);
    expect(setup.status, setup.stderr).toBe(0);
    expect((await api('POST', `/api/v1/install-sessions/${s.id}/connect`, {})).status).toBe(202);
    const awaiting = await hostIs(s.id, 'awaiting_confirmation');
    const fp = (
      await inBox(ASSISTED[0]!, "ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub | awk '{print $2}'")
    ).stdout.trim();
    expect(awaiting.hosts[0].fingerprint).toBe(fp);
    // Nothing ran before confirmation: no agent on the host yet.
    expect((await inBox(ASSISTED[0]!, 'test -e /usr/local/bin/pcp-agentctl; echo $?')).stdout.trim()).toBe(
      '1',
    );
    const host = awaiting.hosts[0];
    expect(
      (
        await api('POST', `/api/v1/install-sessions/${s.id}/hosts/${host.id}/confirm-fingerprint`, {
          fingerprint: fp,
        })
      ).status,
    ).toBe(202);
    const done = await hostIs(s.id, 'installed');
    writeFileSync(join(work, 'assisted-1.log'), JSON.stringify(done, null, 2));
    expect(done.status).toBe('completed');
    expect(done.hosts[0]).toMatchObject({ cleanup: 'done', error: null });
    expect(done.hosts[0].scriptVersion).toMatch(/^[0-9a-f]{64}$/);
    expect(done.hosts[0].output).not.toMatch(/pcp_enr_/);
    expect((await inBox(ASSISTED[0]!, 'systemctl is-active pcp-agent')).stdout.trim()).toBe('active');
    await until('assisted agent', async () => {
      const list = (await api('GET', `/api/v1/products/${productId}/agents`)).json.agents as Json[];
      return list.find((a) => a.hostname === 'assisted-1' && a.lastHeartbeatAt);
    });
    const gone = await inBox(
      ASSISTED[0]!,
      'sleep 3; id pcp-install >/dev/null 2>&1; echo $?; test -e /etc/sudoers.d/pcp-install; echo $?; test -e /home/pcp-install; echo $?',
    );
    expect(gone.stdout.split('\n').filter(Boolean)).toEqual(['1', '1', '1']);
  });

  it('TC-05-09: password mode installs and the password is nowhere afterwards', async () => {
    const PASSWORD = 'Pw-e2e-Secret-7731';
    await target(ASSISTED[1]!, 'assisted-2');
    const user = await inBox(
      ASSISTED[1]!,
      `useradd -m -s /bin/bash admin && echo 'admin:${PASSWORD}' | chpasswd && usermod -aG sudo admin`,
    );
    expect(user.status, user.stderr).toBe(0);
    const s = (
      await api('POST', `/api/v1/environments/${environmentId}/install-sessions`, {
        mode: 'password',
        hosts: [{ host: ASSISTED[1], username: 'admin' }],
      })
    ).json;
    expect(
      (await api('POST', `/api/v1/install-sessions/${s.id}/connect`, { password: PASSWORD })).status,
    ).toBe(202);
    const awaiting = await hostIs(s.id, 'awaiting_confirmation');
    const host = awaiting.hosts[0];
    await api('POST', `/api/v1/install-sessions/${s.id}/hosts/${host.id}/confirm-fingerprint`, {
      fingerprint: host.fingerprint,
    });
    const done = await hostIs(s.id, 'installed');
    expect(done.hosts[0].cleanup).toBe('not_needed');
    expect(JSON.stringify(done)).not.toContain(PASSWORD);
    const dump = await compose([
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'postgres',
      '-d',
      'pcp',
      '-tAc',
      "SELECT row_to_json(x)::text FROM (SELECT * FROM install_session_hosts) x UNION ALL SELECT row_to_json(a)::text FROM audit_logs a WHERE action LIKE 'install_session.%'",
    ]);
    expect(dump.status, dump.stderr).toBe(0);
    expect(dump.stdout).toContain('install_session.host_finished');
    expect(dump.stdout).not.toContain(PASSWORD);
    const logs = await compose(['logs', 'installer-runner', 'api']);
    expect(logs.stdout + logs.stderr).not.toContain(PASSWORD);
  });
});
