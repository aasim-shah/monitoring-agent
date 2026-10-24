import type { ExecutionContext } from '@pcp/connector-sdk';
import { describe, expect, it } from 'vitest';
import { createGrafanaConnector } from './index.js';

const ctx = (): ExecutionContext => ({
  authenticatedOrganizationId: 'org',
  connectionId: 'conn-1',
  executionLocation: 'cloud',
  requestId: 'r',
  deadline: new Date(Date.now() + 30_000).toISOString(),
  config: { baseUrl: 'https://grafana.example.com/' },
  credentials: async () => ({ serviceAccountToken: 'glsa_x' }),
});

const fakeFetch = (answer: (u: URL) => { status: number; body: unknown } | undefined) =>
  (async (input: string | URL) => {
    const u = new URL(String(input));
    const a = answer(u) ?? { status: 404, body: { message: 'Not found' } };
    return new Response(JSON.stringify(a.body), {
      status: a.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;

describe('Grafana connector (WB-06 UC-06-09, BR-06-04)', () => {
  it('validates health and dashboard search; a token without search is permission_denied', async () => {
    const ok = createGrafanaConnector({
      fetch: fakeFetch((u) =>
        u.pathname === '/api/health'
          ? { status: 200, body: { database: 'ok', version: '11.2.0' } }
          : u.pathname === '/api/search'
            ? { status: 200, body: [] }
            : undefined,
      ),
    });
    expect(await ok.validate(ctx())).toEqual({ ok: true, accountId: 'Grafana 11.2.0' });
    const denied = createGrafanaConnector({
      fetch: fakeFetch((u) =>
        u.pathname === '/api/health'
          ? { status: 200, body: { database: 'ok', version: '11.2.0' } }
          : { status: 403, body: { message: 'Access denied' } },
      ),
    });
    expect(await denied.validate(ctx())).toEqual({
      ok: false,
      accountId: 'Grafana 11.2.0',
      missingPermissions: ['Dashboards: Read'],
    });
  });

  it('discovers dashboards as links with their folder', async () => {
    const c = createGrafanaConnector({
      fetch: fakeFetch((u) =>
        u.pathname === '/api/search'
          ? {
              status: 200,
              body: [
                {
                  uid: 'abc',
                  title: 'Node Exporter Full',
                  folderTitle: 'Infra',
                  url: '/d/abc/node-exporter-full',
                  tags: ['linux'],
                  type: 'dash-db',
                },
              ],
            }
          : undefined,
      ),
    });
    const page = await c.discover!(ctx());
    expect(page.observations).toEqual([
      expect.objectContaining({
        resourceType: 'grafana_dashboard',
        externalId: 'abc',
        attributes: {
          name: 'Node Exporter Full',
          title: 'Node Exporter Full',
          folder: 'Infra',
          url: 'https://grafana.example.com/d/abc/node-exporter-full',
          tags: ['linux'],
        },
      }),
    ]);
  });
});
