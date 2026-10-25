import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  agentEnv,
  asAgent,
  enrolledAgent,
  environmentFor,
  type EnrolledAgent,
} from '../test/agent-helpers.js';
import { createTestApp, type TestApp } from '../test/app-factory.js';
import { ownerWithOrg } from '../test/auth-helpers.js';

// Fleet heartbeat capacity (M19.2): heartbeats through the real API handlers and PostgreSQL, in
// process (no network, no Caddy). AGENTS agents beat CONCURRENCY at a time for ROUNDS rounds.
const AGENTS = Number(process.env.LOAD_AGENTS ?? 200);
const ROUNDS = Number(process.env.LOAD_ROUNDS ?? 10);
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 50);

let t: TestApp;
let agents: EnrolledAgent[] = [];

beforeAll(async () => {
  t = await createTestApp({ env: await agentEnv() });
  const owner = await ownerWithOrg(t);
  const { environmentId } = await environmentFor(t, owner);
  for (let i = 0; i < AGENTS; i++)
    agents.push(await enrolledAgent(t, owner, environmentId, { hostname: `load-${i}`, machineId: `m-${i}` }));
}, 600_000);

afterAll(async () => {
  await t?.close();
});

const beat = (a: EnrolledAgent, sequence: number) =>
  t.app.inject({
    method: 'POST',
    url: '/agent/v1/heartbeat',
    ...asAgent(a.fingerprint),
    payload: {
      protocolVersion: '1.0',
      sequence,
      agentVersion: '0.5.0',
      policyVersion: 1,
      capabilities: ['host.health'],
      health: 'ok',
      queueDepth: 0,
      sentAt: new Date().toISOString(),
    },
  });

describe('heartbeat throughput', () => {
  it('measures heartbeats per second and latency', async () => {
    const latencies: number[] = [];
    const queue: Array<[EnrolledAgent, number]> = [];
    for (let r = 1; r <= ROUNDS; r++) for (const a of agents) queue.push([a, r]);
    const started = performance.now();
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        for (let job = queue.shift(); job; job = queue.shift()) {
          const t0 = performance.now();
          const res = await beat(job[0], job[1]);
          latencies.push(performance.now() - t0);
          expect(res.statusCode).toBe(202);
        }
      }),
    );
    const seconds = (performance.now() - started) / 1000;
    latencies.sort((x, y) => x - y);
    const pct = (p: number) =>
      latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))]!;
    const result = {
      agents: AGENTS,
      heartbeats: latencies.length,
      concurrency: CONCURRENCY,
      perSecond: Math.round(latencies.length / seconds),
      p50Ms: Math.round(pct(50)),
      p95Ms: Math.round(pct(95)),
      p99Ms: Math.round(pct(99)),
    };
    writeFileSync(process.env.LOAD_OUT ?? 'heartbeats-load.json', JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  });
});
