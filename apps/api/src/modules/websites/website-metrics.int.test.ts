import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../test/app-factory.js';
import { createProduct, headers, ownerWithOrg } from '../../../test/auth-helpers.js';
import { sql } from '../../../test/db.js';

let t: TestApp;
const nowS = Math.floor(Date.now() / 1000);

beforeAll(async () => {
  t = await createTestApp({ env: { VM_QUERY_URL: inject('vmUrl') } });
});

afterAll(async () => {
  await t?.close();
});

describe('website monitor charts', () => {
  it("returns response time and uptime for the monitor only, from the tenant's own series", async () => {
    const owner = await ownerWithOrg(t);
    const productId = await createProduct(t, owner, `W-${randomUUID().slice(0, 6)}`);
    const [m] = await sql<{ id: string }>(
      `INSERT INTO website_monitors (organization_id, product_id, url, host, verify_token, status, verified_at, updated_at)
       VALUES ($1, $2, 'https://shop.example.com/', 'shop.example.com', 't', 'active', now(), now()) RETURNING id`,
      [owner.orgId, productId],
    );
    const labels = (tenant: string) =>
      `tenant_id="${tenant}",product_id="${productId}",monitor_id="${m!.id}"`;
    const lines = [owner.orgId, randomUUID()].flatMap((tenant, i) =>
      Array.from({ length: 10 }, (_, k) => {
        const ts = (nowS - k * 60) * 1000;
        return [
          `website_response_seconds{${labels(tenant)}} ${i === 0 ? 0.25 : 9} ${ts}`,
          `website_up{${labels(tenant)}} ${i === 0 && k !== 3 ? 1 : 0} ${ts}`,
        ];
      }).flat(),
    );
    await fetch(`${inject('vmUrl')}/api/v1/import/prometheus`, {
      method: 'POST',
      body: lines.join('\n') + '\n',
    });
    await fetch(`${inject('vmUrl')}/internal/force_flush`);
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/v1/website-monitors/${m!.id}/metrics?range=1h`,
      headers: headers(owner.cookie),
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    const latency = body.charts.find((c: { key: string }) => c.key === 'responseTime');
    const values = latency.series[0].points
      .map((p: [number, number | null]) => p[1])
      .filter((v: number | null) => v !== null);
    expect(values.length).toBeGreaterThan(3);
    expect(values.every((v: number) => Math.abs(v - 250) < 1)).toBe(true);
    expect(body.charts.map((c: { key: string; unit: string }) => [c.key, c.unit])).toEqual([
      ['responseTime', 'ms'],
      ['uptime', 'percent'],
    ]);
  });
});
