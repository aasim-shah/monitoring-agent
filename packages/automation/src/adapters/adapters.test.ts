import { describe, expect, it } from 'vitest';
import { cloudflarePurge } from './cloudflare-purge.js';
import { githubDispatch } from './github-dispatch.js';
import type { HttpLike } from './http.js';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function fakeHttp(answer: (c: Call) => { status: number; body?: unknown }) {
  const calls: Call[] = [];
  const http: HttpLike = {
    async request(url, init = {}) {
      const call = {
        url,
        method: init.method ?? 'GET',
        headers: init.headers as Record<string, string>,
        body: init.body as string | undefined,
      };
      calls.push(call);
      const a = answer(call);
      const text = a.body === undefined ? '' : JSON.stringify(a.body);
      return { status: a.status, text: () => text, json: <T>() => JSON.parse(text || 'null') as T };
    },
  };
  return { http, calls };
}

describe('cloudflarePurge (UC-16-06)', () => {
  it('purges by URL and verifies the API answered success', async () => {
    const { http, calls } = fakeHttp(() => ({
      status: 200,
      body: { success: true, result: { id: 'purge-1' }, errors: [] },
    }));
    const r = await cloudflarePurge(http, {
      token: 'cf-token',
      zoneId: 'zone-1',
      params: { urls: ['https://a.example.com/x.css'] },
    });
    expect(r).toEqual({ ok: true, result: { purgeId: 'purge-1' }, verification: { apiSuccess: true } });
    expect(calls[0]).toMatchObject({
      url: 'https://api.cloudflare.com/client/v4/zones/zone-1/purge_cache',
      method: 'POST',
      body: JSON.stringify({ files: ['https://a.example.com/x.css'] }),
    });
    expect(calls[0]!.headers.authorization).toBe('Bearer cf-token');
  });

  it('reports the API error', async () => {
    const { http } = fakeHttp(() => ({
      status: 403,
      body: { success: false, errors: [{ message: 'Authentication error' }] },
    }));
    expect(await cloudflarePurge(http, { token: 't', zoneId: 'z', params: { everything: true } })).toEqual({
      ok: false,
      error: 'Cloudflare answered 403: Authentication error',
    });
  });
});

describe('githubDispatch (UC-16-07)', () => {
  it('dispatches and verifies that a run appeared', async () => {
    const dispatchedAt = new Date('2026-10-24T10:00:00Z');
    let polls = 0;
    const { http, calls } = fakeHttp((c) => {
      if (c.method === 'POST') return { status: 204 };
      polls++;
      return {
        status: 200,
        body: {
          workflow_runs:
            polls < 2
              ? []
              : [
                  {
                    id: 42,
                    html_url: 'https://github.com/acme/shop/actions/runs/42',
                    status: 'queued',
                    created_at: '2026-10-24T10:00:03Z',
                  },
                ],
        },
      };
    });
    const r = await githubDispatch(http, {
      token: 'gh-token',
      repo: 'acme/shop',
      workflow: 'deploy.yml',
      ref: 'main',
      now: () => dispatchedAt,
      sleep: async () => {},
    });
    expect(r).toEqual({
      ok: true,
      result: { runId: 42, url: 'https://github.com/acme/shop/actions/runs/42' },
      verification: { runCreated: true, status: 'queued' },
    });
    expect(calls[0]).toMatchObject({
      url: 'https://api.github.com/repos/acme/shop/actions/workflows/deploy.yml/dispatches',
      body: JSON.stringify({ ref: 'main' }),
    });
  });

  it('fails verification when no run appears within the window (TC-16-09)', async () => {
    const { http } = fakeHttp((c) =>
      c.method === 'POST' ? { status: 204 } : { status: 200, body: { workflow_runs: [] } },
    );
    expect(
      await githubDispatch(http, {
        token: 't',
        repo: 'acme/shop',
        workflow: 'deploy.yml',
        ref: 'main',
        now: () => new Date(),
        sleep: async () => {},
      }),
    ).toEqual({
      ok: false,
      error: 'No workflow run appeared within 30 s',
      verification: { runCreated: false },
    });
  });
});
