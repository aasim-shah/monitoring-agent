import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReadinessCheck } from '@pcp/health';
import { createHealthServer } from './health-server.js';

let server: Server | undefined;

async function start(checks: ReadinessCheck[]) {
  server = createHealthServer({ service: 'worker', deploymentMode: 'managed', checks });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await new Promise((resolve) => server?.close(resolve));
  server = undefined;
});

describe('worker health server', () => {
  it('GET /healthz returns ok', async () => {
    const res = await fetch(`${await start([])}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', service: 'worker', deploymentMode: 'managed' });
  });

  it('GET /readyz returns 503 when redis check fails', async () => {
    const base = await start([
      {
        name: 'redis',
        check: async () => {
          throw new Error('ECONNREFUSED');
        },
      },
    ]);
    const res = await fetch(`${base}/readyz`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      status: 'not_ready',
      checks: [{ name: 'redis', ok: false, error: 'ECONNREFUSED' }],
    });
  });

  it('returns 404 for other paths', async () => {
    const res = await fetch(`${await start([])}/other`);
    expect(res.status).toBe(404);
  });
});
