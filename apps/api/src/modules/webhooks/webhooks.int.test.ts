import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../test/app-factory.js';
import { headers, ownerWithOrg, type Owner } from '../../../test/auth-helpers.js';
import { sql } from '../../../test/db.js';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ env: { PCP_ENABLE_MOCK_CONNECTOR: '1' } });
});

afterAll(async () => {
  await t?.close();
});

/** A connected mock connection with a webhook secret, as an admin would set it up. */
async function connection(owner: Owner, secret: string) {
  const created = await t.app.inject({
    method: 'POST',
    url: `/api/v1/organizations/${owner.orgId}/connections`,
    headers: headers(owner.cookie),
    payload: {
      provider: 'mock',
      displayName: 'Mock',
      executionLocation: 'cloud',
      config: { behavior: 'ok' },
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json().id as string;
  const auth = await t.app.inject({
    method: 'POST',
    url: `/api/v1/connections/${id}/authorize`,
    headers: headers(owner.cookie),
    payload: { credentials: { token: 'mock-token', webhookSecret: secret } },
  });
  expect(auth.statusCode, auth.body).toBeLessThan(300);
  await sql(`UPDATE connections SET status = 'connected' WHERE id = $1`, [id]);
  return id;
}

const sign = (secret: string, body: string) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

function post(
  connectionId: string,
  body: string,
  secret: string,
  delivery: string,
  extra: Record<string, string> = {},
) {
  return t.app.inject({
    method: 'POST',
    url: `/webhooks/mock/${connectionId}`,
    headers: {
      'content-type': 'application/json',
      'x-mock-signature': sign(secret, body),
      'x-mock-delivery': delivery,
      'x-mock-event': 'deployment_status',
      ...extra,
    },
    payload: body,
  });
}

const events = (connectionId: string) =>
  sql<{ kind: string; title: string }>(`SELECT kind, title FROM change_events WHERE connection_id = $1`, [
    connectionId,
  ]);

describe('webhook ingestion (WB-06 UC-06-10, BR-06-05)', () => {
  it('TC-06-03: a signed event becomes one change event; a replay is a no-op', async () => {
    const owner = await ownerWithOrg(t);
    const id = await connection(owner, 'whsec-1');
    const body = JSON.stringify({ id: 'dep-42', kind: 'deployment', title: 'Deployed main to production' });
    const delivery = randomUUID();
    const first = await post(id, body, 'whsec-1', delivery);
    expect(first.statusCode, first.body).toBe(202);
    expect(first.json()).toEqual({ accepted: true, changeEvents: 1 });
    const replay = await post(id, body, 'whsec-1', delivery);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ duplicate: true });
    expect(await events(id)).toEqual([{ kind: 'deployment', title: 'Deployed main to production' }]);
    const deliveries = await sql<{ result: string; event_type: string }>(
      `SELECT result, event_type FROM webhook_deliveries WHERE connection_id = $1`,
      [id],
    );
    expect(deliveries).toEqual([{ result: 'processed', event_type: 'deployment_status' }]);
  });

  it('TC-06-04: a bad signature is 401 and audited; an unknown connection gives the identical body', async () => {
    const owner = await ownerWithOrg(t);
    const id = await connection(owner, 'whsec-2');
    const body = JSON.stringify({ id: 'x', kind: 'deployment' });
    const forged = await post(id, body, 'wrong-secret', randomUUID());
    const unknown = await post(randomUUID(), body, 'whsec-2', randomUUID());
    const notUuid = await post('not-a-uuid', body, 'whsec-2', randomUUID());
    expect([forged.statusCode, unknown.statusCode, notUuid.statusCode]).toEqual([401, 401, 401]);
    // Identical apart from the per-request ID.
    const shape = (r: { json(): { code: string; message: string } }) => ({
      code: r.json().code,
      message: r.json().message,
    });
    expect(shape(unknown)).toEqual(shape(forged));
    expect(shape(notUuid)).toEqual(shape(forged));
    expect(await events(id)).toEqual([]);
    const audit = await sql<{ action: string }>(
      `SELECT action FROM audit_logs WHERE organization_id = $1 AND action = 'webhook.rejected'`,
      [owner.orgId],
    );
    expect(audit).toHaveLength(1);
  });

  it("refuses a disconnected connection, a provider mismatch, and another connection's secret (Review Focus #5)", async () => {
    const a = await ownerWithOrg(t);
    const b = await ownerWithOrg(t);
    const idA = await connection(a, 'secret-a');
    const idB = await connection(b, 'secret-b');
    const body = JSON.stringify({ id: 'y', kind: 'deployment' });
    expect((await post(idA, body, 'secret-b', randomUUID())).statusCode).toBe(401);
    const wrongProvider = await t.app.inject({
      method: 'POST',
      url: `/webhooks/github/${idB}`,
      headers: { 'content-type': 'application/json', 'x-mock-signature': sign('secret-b', body) },
      payload: body,
    });
    expect(wrongProvider.statusCode).toBe(401);
    await sql(`UPDATE connections SET status = 'disconnected' WHERE id = $1`, [idB]);
    expect((await post(idB, body, 'secret-b', randomUUID())).statusCode).toBe(401);
  });

  it('records ignored events and revokes the connection on a provider revocation (TC-06-08)', async () => {
    const owner = await ownerWithOrg(t);
    const id = await connection(owner, 'whsec-3');
    const ignored = await post(id, JSON.stringify({ hello: 'world' }), 'whsec-3', randomUUID());
    expect(ignored.json()).toEqual({ accepted: true, changeEvents: 0 });
    const revoke = await post(id, JSON.stringify({ revoke: true }), 'whsec-3', randomUUID());
    expect(revoke.statusCode).toBe(202);
    const [c] = await sql<{ status: string }>(`SELECT status FROM connections WHERE id = $1`, [id]);
    expect(c!.status).toBe('revoked');
    const results = await sql<{ result: string }>(
      `SELECT result FROM webhook_deliveries WHERE connection_id = $1 ORDER BY received_at`,
      [id],
    );
    expect(results.map((r) => r.result)).toEqual(['ignored', 'processed']);
  });

  it('refuses bodies over 1 MB', async () => {
    const owner = await ownerWithOrg(t);
    const id = await connection(owner, 'whsec-4');
    const big = JSON.stringify({ pad: 'x'.repeat(1_100_000) });
    expect((await post(id, big, 'whsec-4', randomUUID())).statusCode).toBe(413);
  });
});
