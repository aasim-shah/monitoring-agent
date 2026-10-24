import { createServer, type Server } from 'node:http';
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentEnv, enrolledAgent, environmentFor } from '../../../test/agent-helpers.js';
import { createTestApp, type TestApp } from '../../../test/app-factory.js';
import { ownerWithOrg } from '../../../test/auth-helpers.js';

/** A stand-in VictoriaMetrics that records each query and answers with one empty series. */
function fakeVm() {
  const queries: URLSearchParams[] = [];
  const server: Server = createServer((req, res) => {
    queries.push(new URL(req.url ?? '/', 'http://x').searchParams);
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        status: 'success',
        data: { resultType: 'matrix', result: [{ metric: {}, values: [] }] },
      }),
    );
  });
  return { server, queries, url: '' };
}

const raw = fakeVm();
const longterm = fakeVm();
let t: TestApp;
const since = new Date(Date.now() - 10 * 86400_000);

beforeAll(async () => {
  for (const vm of [raw, longterm])
    vm.url = await new Promise<string>((r) =>
      vm.server.listen(0, '127.0.0.1', () =>
        r(`http://127.0.0.1:${(vm.server.address() as { port: number }).port}`),
      ),
    );
  t = await createTestApp({
    env: {
      ...(await agentEnv()),
      VM_QUERY_URL: raw.url,
      VM_LONGTERM_URL: longterm.url,
      ROLLUPS_SINCE: since.toISOString(),
    },
  });
});

afterAll(async () => {
  await t?.close();
  for (const vm of [raw, longterm]) await new Promise((r) => vm.server.close(r));
});

describe('long-term rollups (M18.4)', () => {
  it('a 90-day host chart reads the rollups and reports partial data before they began', async () => {
    const owner = await ownerWithOrg(t);
    const { environmentId } = await environmentFor(t, owner);
    const agent = await enrolledAgent(t, owner, environmentId);
    const get = (range: string) =>
      t.app.inject({
        method: 'GET',
        url: `/api/v1/agents/${agent.agentId}/metrics?range=${range}`,
        headers: { cookie: owner.cookie },
      });
    const before = { raw: raw.queries.length, longterm: longterm.queries.length };
    const res = await get('90d');
    expect(res.statusCode, res.body).toBe(200);
    expect(longterm.queries.length - before.longterm).toBe(5);
    expect(raw.queries.length).toBe(before.raw);
    expect(res.json()).toMatchObject({
      completeness: 'partial',
      gaps: [`rollups: 5-minute data starts ${since.toISOString()}`],
    });
    const sent = longterm.queries.at(-1)!;
    expect(sent.get('extra_label')).toBe(`tenant_id=${owner.orgId}`);
    expect(Number(sent.get('step')!.replace('s', ''))).toBeGreaterThanOrEqual(300);
    expect(longterm.queries.map((q) => q.get('query')).join(' ')).not.toContain('[5m]');
    const recent = await get('24h');
    expect(recent.json()).toMatchObject({ completeness: 'complete', gaps: [] });
    expect(raw.queries.length).toBe(before.raw + 5);
  });
});
