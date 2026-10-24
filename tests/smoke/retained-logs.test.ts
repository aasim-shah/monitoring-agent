import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { run } from './compose.js';

// Retained logs (M18.1, BR-12-08) at the storage: AccountID isolates tenants, and the gateway's
// extra_fields override whatever tenant fields a log line claims.
const VL = `pcp-vlogs-test-${process.pid}`;
const BASE = 'http://127.0.0.1:18433';

async function until<T>(f: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f().catch(() => undefined);
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 500));
  }
}

const ingest = (accountId: string, line: object, extra: string) =>
  fetch(`${BASE}/insert/jsonline?_stream_fields=agent_id&extra_fields=${encodeURIComponent(extra)}`, {
    method: 'POST',
    headers: { AccountID: accountId, ProjectID: '0' },
    body: JSON.stringify(line) + '\n',
  });

const search = async (accountId: string, query: string) => {
  const res = await fetch(`${BASE}/select/logsql/query?query=${encodeURIComponent(query)}`, {
    headers: { AccountID: accountId, ProjectID: '0' },
  });
  return (await res.text())
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, string>);
};

beforeAll(async () => {
  const up = await run('docker', [
    'run',
    '-d',
    '--rm',
    '--name',
    VL,
    '--memory',
    '128m',
    '-p',
    '127.0.0.1:18433:9428',
    'victoriametrics/victoria-logs:v1.51.1',
    '-retentionPeriod=7d',
  ]);
  expect(up.status, up.stderr).toBe(0);
  await until(async () => ((await fetch(`${BASE}/health`)).ok ? true : undefined));
}, 120_000);

afterAll(async () => {
  await run('docker', ['rm', '-f', VL]);
});

describe('retained logs storage (M18.1)', () => {
  it('TC-12-09: tenant B never sees tenant A, and forged tenant fields are overwritten', async () => {
    const t0 = new Date().toISOString();
    expect(
      (
        await ingest(
          '7',
          { _time: t0, _msg: 'checkout failed for order 42', tenant_id: 'tenant-b', agent_id: 'forged' },
          'tenant_id=tenant-a,product_id=p-a,agent_id=a-1',
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await ingest(
          '8',
          { _time: t0, _msg: 'tenant b line', agent_id: 'b' },
          'tenant_id=tenant-b,product_id=p-b,agent_id=b-1',
        )
      ).status,
    ).toBe(200);
    await fetch(`${BASE}/internal/force_flush`);
    const a = await until(async () => {
      const r = await search('7', 'product_id:="p-a" checkout');
      return r.length ? r : undefined;
    });
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ tenant_id: 'tenant-a', product_id: 'p-a', agent_id: 'a-1' });
    expect(await search('8', 'checkout')).toEqual([]);
    expect(await search('8', '*')).toEqual([expect.objectContaining({ _msg: 'tenant b line' })]);
  });
});
