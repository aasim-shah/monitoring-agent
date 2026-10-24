import { createHmac } from 'node:crypto';
import type { ExecutionContext } from '@pcp/connector-sdk';
import { describe, expect, it } from 'vitest';
import { assertAllowedPath, createGithubConnector } from './index.js';

const ctx = (config: Record<string, unknown> = { owner: 'acme' }): ExecutionContext => ({
  authenticatedOrganizationId: 'org',
  connectionId: 'conn-1',
  executionLocation: 'cloud',
  requestId: 'r',
  deadline: new Date(Date.now() + 30_000).toISOString(),
  config,
  credentials: async () => ({ token: 'github_pat_x', webhookSecret: 'whsec' }),
});

type Route = (
  url: URL,
  init: RequestInit,
) => { status: number; body: unknown; headers?: Record<string, string> } | undefined;

function fakeFetch(routes: Route[]) {
  const calls: string[] = [];
  const fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push(`${init.method ?? 'GET'} ${url.pathname}`);
    for (const r of routes) {
      const hit = r(url, init);
      if (hit)
        return new Response(hit.status === 204 ? null : JSON.stringify(hit.body), {
          status: hit.status,
          headers: { 'content-type': 'application/json', ...(hit.headers ?? {}) },
        });
    }
    return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const at =
  (path: string, body: unknown, status = 200): Route =>
  (u) =>
    u.pathname === path ? { status, body } : undefined;
const repo = {
  id: 101,
  full_name: 'acme/shop',
  name: 'shop',
  default_branch: 'main',
  visibility: 'private',
  html_url: 'https://github.com/acme/shop',
};
const fixtures = [
  at('/user', { login: 'ops-bot' }),
  at('/users/acme/repos', [repo]),
  at('/repos/acme/shop', repo),
  at('/repos/acme/shop/actions/workflows', {
    workflows: [{ id: 7, name: 'Deploy', path: '.github/workflows/deploy.yml', state: 'active' }],
  }),
  at('/repos/acme/shop/deployments', [
    { id: 55, environment: 'production', ref: 'main', sha: 'abc', created_at: '2026-10-24T09:00:00Z' },
  ]),
  at('/repos/acme/shop/releases', [
    {
      id: 9,
      tag_name: 'v1.4.0',
      name: 'v1.4.0',
      published_at: '2026-10-23T12:00:00Z',
      html_url: 'https://github.com/acme/shop/releases/v1.4.0',
    },
  ]),
];

describe('GitHub connector (WB-06 UC-06-05/06)', () => {
  it('validates the token and repository access', async () => {
    const c = createGithubConnector({ fetch: fakeFetch(fixtures).fetch });
    expect(await c.validate(ctx())).toEqual({ ok: true, accountId: 'ops-bot' });
    const limited = createGithubConnector({ fetch: fakeFetch(fixtures).fetch });
    expect(await limited.validate(ctx({ owner: 'acme', repositories: ['shop', 'billing'] }))).toEqual({
      ok: false,
      accountId: 'ops-bot',
      missingPermissions: ['Repository access: acme/billing'],
    });
  });

  it('a rejected token needs reauthorization; an exhausted rate limit is rate_limited with the reset', async () => {
    const bad = createGithubConnector({
      fetch: fakeFetch([at('/user', { message: 'Bad credentials' }, 401)]).fetch,
    });
    await expect(bad.validate(ctx())).rejects.toMatchObject({ reason: 'reauthorization_required' });
    const reset = Math.floor(Date.now() / 1000) + 120;
    const limited = createGithubConnector({
      fetch: fakeFetch([
        (u) =>
          u.pathname === '/user'
            ? {
                status: 403,
                body: { message: 'API rate limit exceeded' },
                headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
              }
            : undefined,
      ]).fetch,
    });
    const err = await limited.validate(ctx()).catch((e) => e);
    expect(err).toMatchObject({ reason: 'rate_limited' });
    expect(err.retryAfterSeconds).toBeGreaterThan(100);
  });

  it('discovers repositories, workflows, deployments, and releases', async () => {
    const page = await createGithubConnector({ fetch: fakeFetch(fixtures).fetch }).discover!(ctx());
    const types = page.observations.map((o) => o.resourceType);
    expect(types).toEqual(['github_repository', 'github_workflow', 'github_deployment', 'github_release']);
    expect(page.observations[0]).toMatchObject({
      externalId: '101',
      attributes: { name: 'acme/shop', fullName: 'acme/shop', defaultBranch: 'main', visibility: 'private' },
    });
  });

  it('TC-06-05: never calls a secrets endpoint or anything outside the allowlist (BR-06-02)', () => {
    for (const path of [
      '/repos/acme/shop/actions/secrets',
      '/repos/acme/shop/actions/secrets/KEY',
      '/orgs/acme/actions/secrets',
      '/repos/acme/shop/contents/.env',
      '/user/keys',
      '/repos/acme/shop/hooks',
    ])
      expect(() => assertAllowedPath(path), path).toThrow(/not allowed/);
    for (const path of [
      '/user',
      '/repos/acme/shop',
      '/repos/acme/shop/actions/workflows',
      '/repos/acme/shop/deployments',
      '/repos/acme/shop/releases',
    ])
      expect(() => assertAllowedPath(path), path).not.toThrow();
  });

  it('verifies X-Hub-Signature-256 with the connection secret', () => {
    const c = createGithubConnector({});
    const raw = Buffer.from('{"zen":"Keep it logically awesome."}');
    const sig = `sha256=${createHmac('sha256', 'whsec').update(raw).digest('hex')}`;
    const req = (s: string) => ({
      headers: { 'x-hub-signature-256': s, 'x-github-delivery': 'd-1', 'x-github-event': 'ping' },
      rawBody: raw,
      payload: {},
    });
    expect(c.verifyWebhook!(req(sig), { token: 't', webhookSecret: 'whsec' })).toEqual({
      ok: true,
      deliveryId: 'd-1',
      eventType: 'ping',
    });
    expect(c.verifyWebhook!(req('sha256=00'), { token: 't', webhookSecret: 'whsec' })).toEqual({ ok: false });
    expect(c.verifyWebhook!(req(sig), { token: 't' })).toEqual({ ok: false });
  });

  it('TC-06-03: normalizes deployments, failed workflows, releases, default-branch pushes, and revocation', async () => {
    const c = createGithubConnector({});
    const repository = { full_name: 'acme/shop', default_branch: 'main' };
    const ingest = (eventType: string, payload: unknown) =>
      c.ingestEvent!(ctx(), { eventType, headers: {}, payload });
    const [dep] = await ingest('deployment_status', {
      deployment_status: {
        state: 'success',
        target_url: 'https://shop.example.com',
        created_at: '2026-10-24T10:00:00Z',
        creator: { login: 'ci' },
      },
      deployment: { id: 55, environment: 'production', ref: 'main', sha: 'abc' },
      repository,
    });
    expect(dep).toMatchObject({
      resourceType: 'change_event',
      attributes: {
        kind: 'deployment',
        title: 'Deployed main to production (acme/shop)',
        actor: 'ci',
        externalId: '55:success',
        occurredAt: '2026-10-24T10:00:00Z',
      },
    });
    const [failedDep] = await ingest('deployment_status', {
      deployment_status: { state: 'failure', created_at: '2026-10-24T10:00:00Z' },
      deployment: { id: 56, environment: 'production', ref: 'main' },
      repository,
    });
    expect(failedDep!.attributes.kind).toBe('deployment_failed');
    const [wf] = await ingest('workflow_run', {
      action: 'completed',
      workflow_run: {
        id: 900,
        name: 'CI',
        conclusion: 'failure',
        head_branch: 'main',
        html_url: 'https://github.com/acme/shop/actions/runs/900',
        updated_at: '2026-10-24T10:05:00Z',
      },
      repository,
    });
    expect(wf!.attributes).toMatchObject({
      kind: 'workflow_failed',
      title: 'Workflow CI failed on main (acme/shop)',
    });
    expect(
      await ingest('workflow_run', {
        action: 'completed',
        workflow_run: { id: 901, conclusion: 'success' },
        repository,
      }),
    ).toEqual([]);
    const [rel] = await ingest('release', {
      action: 'published',
      release: { id: 9, tag_name: 'v1.4.0', published_at: '2026-10-24T11:00:00Z' },
      repository,
    });
    expect(rel!.attributes).toMatchObject({ kind: 'release', title: 'Released v1.4.0 (acme/shop)' });
    const [push] = await ingest('push', {
      ref: 'refs/heads/main',
      after: 'def',
      commits: [{}, {}],
      repository,
      pusher: { name: 'dev' },
    });
    expect(push!.attributes).toMatchObject({ kind: 'push', title: '2 commits pushed to main (acme/shop)' });
    expect(
      await ingest('push', { ref: 'refs/heads/feature', after: 'x', commits: [{}], repository }),
    ).toEqual([]);
    const [revoked] = await ingest('github_app_authorization', { action: 'revoked' });
    expect(revoked!.resourceType).toBe('connection_revoked');
  });

  it('dispatches an allowlisted workflow and verifies a run appeared (M16 UC-16-07)', async () => {
    const { fetch, calls } = fakeFetch([
      (u, i) =>
        u.pathname === '/repos/acme/shop/actions/workflows/deploy.yml/dispatches' && i.method === 'POST'
          ? { status: 204, body: null }
          : undefined,
      at('/repos/acme/shop/actions/workflows/deploy.yml/runs', {
        workflow_runs: [
          {
            id: 1,
            html_url: 'https://github.com/acme/shop/actions/runs/1',
            status: 'queued',
            created_at: new Date().toISOString(),
          },
        ],
      }),
    ]);
    const out = await createGithubConnector({ fetch, sleep: async () => {} }).executeAction!(ctx(), {
      kind: 'workflow_dispatch',
      repo: 'acme/shop',
      workflow: 'deploy.yml',
      ref: 'main',
    });
    expect(out).toMatchObject({ ok: true, result: { runId: 1 }, verification: { runCreated: true } });
    expect(calls[0]).toBe('POST /repos/acme/shop/actions/workflows/deploy.yml/dispatches');
  });
});
