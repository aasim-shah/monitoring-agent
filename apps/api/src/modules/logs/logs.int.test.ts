import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  agentEnv,
  asAgent,
  enrolledAgent,
  environmentFor,
  type EnrolledAgent,
} from '../../../test/agent-helpers.js';
import { createTestApp, type TestApp } from '../../../test/app-factory.js';
import { headers, login, ownerWithOrg, signUpAndVerify, type Owner } from '../../../test/auth-helpers.js';
import { sql } from '../../../test/db.js';

let t: TestApp;
let base: string;
let now = Date.now();

beforeAll(async () => {
  t = await createTestApp({ env: await agentEnv(), clock: () => new Date(now) });
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  const address = t.app.getHttpServer().address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(async () => {
  await t?.close();
});

interface Setup {
  owner: Owner;
  productId: string;
  environmentId: string;
}

async function setup(): Promise<Setup> {
  const owner = await ownerWithOrg(t);
  return { owner, ...(await environmentFor(t, owner)) };
}

async function agentWithPacks(s: Setup, packs: Record<string, 'applied' | 'pending'>) {
  const agent = await enrolledAgent(t, s.owner, s.environmentId);
  for (const [packId, status] of Object.entries(packs))
    await sql(
      `INSERT INTO agent_pack_assignments (organization_id, agent_id, pack_id, status, policy_version, updated_at)
       VALUES ($1, $2, $3, $4, 1, now())`,
      [s.owner.orgId, agent.agentId, packId, status],
    );
  return agent;
}

const cookieOnly = (cookie: string) => {
  const { 'content-type': _, ...rest } = headers(cookie);
  return rest;
};

interface SseEvent {
  event: string;
  data: unknown;
}

/** An open SSE connection: collects parsed events; `close()` drops the TCP connection like a closed tab. */
async function openTail(cookie: string, agentId: string, source: string) {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/v1/agents/${agentId}/logs/tail?source=${encodeURIComponent(source)}`, {
    headers: { cookie },
    signal: ctrl.signal,
  });
  const events: SseEvent[] = [];
  let ended = false;
  let text = '';
  const pump = (async () => {
    if (!res.ok || !res.body) return;
    const decoder = new TextDecoder();
    try {
      for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
        text += decoder.decode(part, { stream: true });
        let cut: number;
        while ((cut = text.indexOf('\n\n')) >= 0) {
          const block = text.slice(0, cut);
          text = text.slice(cut + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (event) events.push({ event, data: data ? JSON.parse(data) : null });
        }
      }
    } catch {
      // aborted
    }
    ended = true;
  })();
  return {
    res,
    events,
    get ended() {
      return ended;
    },
    async next(event: string, timeoutMs = 5000): Promise<SseEvent> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = events.find((e) => e.event === event);
        if (found) return found;
        if (Date.now() > deadline) throw new Error(`no ${event} event; got ${JSON.stringify(events)}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    async close() {
      ctrl.abort();
      await pump;
    },
    async body() {
      return res.ok ? '' : res.text();
    },
  };
}

const poll = (agent: EnrolledAgent) =>
  t.app.inject({ method: 'GET', url: '/agent/v1/tasks?wait=0', ...asAgent(agent.fingerprint) });

const chunk = (agent: EnrolledAgent, sessionId: string, sequence: number, lines: string[], final = false) =>
  t.app.inject({
    method: 'POST',
    url: `/agent/v1/streams/${sessionId}/chunks`,
    ...asAgent(agent.fingerprint),
    payload: { sessionId, sequence, lines, final, sentAt: new Date(now).toISOString() },
  });

async function eventually(check: () => Promise<boolean>, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const sessionStatus = async (sessionId: string) =>
  (await sql<{ status: string }>(`SELECT status FROM agent_stream_sessions WHERE id = $1`, [sessionId]))[0]
    ?.status;

async function member(s: Setup, role: string) {
  const email = await signUpAndVerify(t);
  const [u] = await sql<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email]);
  await sql(
    `INSERT INTO organization_members (id, organization_id, user_id, role, all_products, product_ids)
     VALUES ($1, $2, $3, $4, false, ARRAY[$5]::uuid[])`,
    [randomUUID(), s.owner.orgId, u!.id, role, s.productId],
  );
  return login(t, email);
}

describe('log sources (WB-12 allowlist)', () => {
  it('lists the applied packs’ sources plus the system journal', async () => {
    const s = await setup();
    const agent = await agentWithPacks(s, { redis: 'applied', nginx: 'applied', postgresql: 'pending' });
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/v1/agents/${agent.agentId}/log-sources`,
      headers: cookieOnly(s.owner.cookie),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().sources.map((x: { id: string }) => x.id)).toEqual([
      'redis.server',
      'nginx.access',
      'nginx.error',
      'host.journal',
    ]);
    expect(res.json().sources[0]).toEqual({ id: 'redis.server', label: 'Redis server log' });
  });
});

describe('live tail over SSE (WB-12 UC-12-01)', () => {
  it('sends a source-only log_tail task and relays chunks until the final one', async () => {
    const s = await setup();
    const agent = await agentWithPacks(s, { redis: 'applied' });
    const tail = await openTail(s.owner.cookie, agent.agentId, 'redis.server');
    expect(tail.res.status).toBe(200);
    expect(tail.res.headers.get('content-type')).toContain('text/event-stream');
    expect(tail.res.headers.get('x-accel-buffering')).toBe('no');
    const [task] = (await poll(agent)).json().tasks;
    expect(task).toMatchObject({ type: 'log_tail', maxRuntimeSeconds: 900 });
    // The source ID only: a path never travels in the task (Review Focus #1).
    expect(Object.keys(task.payload).sort()).toEqual(['sessionId', 'source']);
    expect(task.payload.source).toBe('redis.server');
    expect(new Date(task.expiresAt).getTime() - now).toBe(15 * 60_000);
    const sessionId = task.payload.sessionId as string;
    await tail.next('ready');
    expect((await chunk(agent, sessionId, 0, ['first line', 'second line'])).statusCode).toBe(202);
    expect((await tail.next('lines')).data).toEqual({ sequence: 0, lines: ['first line', 'second line'] });
    expect((await chunk(agent, sessionId, 1, [], true)).statusCode).toBe(202);
    await tail.next('end');
    await eventually(async () => tail.ended);
    await eventually(async () => (await sessionStatus(sessionId)) === 'closed');
  });

  it('closes the session when the browser disconnects, so the agent’s next chunk is refused', async () => {
    const s = await setup();
    const agent = await agentWithPacks(s, { redis: 'applied' });
    const tail = await openTail(s.owner.cookie, agent.agentId, 'host.journal');
    const [task] = (await poll(agent)).json().tasks;
    const sessionId = task.payload.sessionId as string;
    await tail.next('ready');
    await tail.close();
    await eventually(async () => (await sessionStatus(sessionId)) === 'closed');
    expect((await chunk(agent, sessionId, 0, ['late'])).statusCode).toBe(404);
    // The per-agent limit is released: two new streams fit again.
    const a = await openTail(s.owner.cookie, agent.agentId, 'host.journal');
    const b = await openTail(s.owner.cookie, agent.agentId, 'host.journal');
    expect([a.res.status, b.res.status]).toEqual([200, 200]);
    await Promise.all([a.close(), b.close()]);
  });

  it('reports a task the agent refused as an error event', async () => {
    const s = await setup();
    const agent = await agentWithPacks(s, { redis: 'applied' });
    const tail = await openTail(s.owner.cookie, agent.agentId, 'redis.server');
    const [task] = (await poll(agent)).json().tasks;
    const res = await t.app.inject({
      method: 'POST',
      url: `/agent/v1/tasks/${task.id}/result`,
      ...asAgent(agent.fingerprint),
      payload: { status: 'failed', error: 'log source "redis.server" is not allowed on this host' },
    });
    expect(res.statusCode, res.body).toBe(204);
    expect((await tail.next('error')).data).toEqual({
      message: 'log source "redis.server" is not allowed on this host',
    });
    await eventually(async () => tail.ended);
    await eventually(async () => (await sessionStatus(task.payload.sessionId)) === 'closed');
  });
});

describe('live tail refusals', () => {
  it('refuses unknown, not-enabled, and path-like sources with 400', async () => {
    const s = await setup();
    const agent = await agentWithPacks(s, { redis: 'applied', mysql: 'pending' });
    for (const source of ['mysql.error', 'kafka.server', '/etc/shadow', '../../etc/passwd', '']) {
      const tail = await openTail(s.owner.cookie, agent.agentId, source);
      expect(tail.res.status, source).toBe(400);
      await tail.close();
    }
    expect((await poll(agent)).json().tasks).toEqual([]);
  });

  it('hides live tail from a viewer (404) but lets them list sources', async () => {
    const s = await setup();
    const agent = await agentWithPacks(s, { redis: 'applied' });
    const viewer = await member(s, 'viewer');
    const tail = await openTail(viewer, agent.agentId, 'redis.server');
    expect(tail.res.status).toBe(404);
    await tail.close();
    const sources = await t.app.inject({
      method: 'GET',
      url: `/api/v1/agents/${agent.agentId}/log-sources`,
      headers: cookieOnly(viewer),
    });
    expect(sources.statusCode).toBe(200);
    const operator = await member(s, 'operator');
    const allowed = await openTail(operator, agent.agentId, 'redis.server');
    expect(allowed.res.status).toBe(200);
    await allowed.close();
  });

  it('allows 2 streams per agent and 5 per tenant (429 beyond)', async () => {
    const s = await setup();
    const [a1, a2, a3] = await Promise.all([1, 2, 3].map(() => agentWithPacks(s, {})));
    const open = [
      await openTail(s.owner.cookie, a1!.agentId, 'host.journal'),
      await openTail(s.owner.cookie, a1!.agentId, 'host.journal'),
    ];
    const third = await openTail(s.owner.cookie, a1!.agentId, 'host.journal');
    expect(third.res.status).toBe(429);
    expect(await third.body()).toContain('2 live tails');
    open.push(
      await openTail(s.owner.cookie, a2!.agentId, 'host.journal'),
      await openTail(s.owner.cookie, a2!.agentId, 'host.journal'),
      await openTail(s.owner.cookie, a3!.agentId, 'host.journal'),
    );
    expect(open.map((x) => x.res.status)).toEqual([200, 200, 200, 200, 200]);
    const sixth = await openTail(s.owner.cookie, a3!.agentId, 'host.journal');
    expect(sixth.res.status).toBe(429);
    expect(await sixth.body()).toContain('5 live tails');
    await Promise.all(open.map((x) => x.close()));
  });

  it('frees slots held by a crashed API instance once the 15-minute TTL passes', async () => {
    const s = await setup();
    const agent = await agentWithPacks(s, {});
    // Slots taken by another instance that died without releasing them.
    const redis = t.app.get((await import('../../tokens.js')).REDIS);
    for (const id of [randomUUID(), randomUUID()])
      await redis.zadd(`logtail:agent:${agent.agentId}`, now + 15 * 60_000, id);
    const blocked = await openTail(s.owner.cookie, agent.agentId, 'host.journal');
    expect(blocked.res.status).toBe(429);
    now += 15 * 60_000 + 1000;
    try {
      const ok = await openTail(s.owner.cookie, agent.agentId, 'host.journal');
      expect(ok.res.status).toBe(200);
      await ok.close();
    } finally {
      now -= 15 * 60_000 + 1000;
    }
  });
});
