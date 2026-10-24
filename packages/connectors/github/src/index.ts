import { githubDispatch, type AdapterResult, type HttpLike } from '@pcp/automation';
import {
  ConnectorError,
  createHttpClient,
  hmacSha256Hex,
  safeEqual,
  type Connector,
  type DestinationOptions,
  type ExecutionContext,
} from '@pcp/connector-sdk';
import type { Observation } from '@pcp/shared-contracts';

export interface GithubOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  destination?: DestinationOptions;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The only GitHub API paths this connector may call (BR-06-02, TC-06-05): metadata, workflows
 * and runs, deployments, releases, branches. Secrets, contents, keys, and hooks are never reachable.
 */
const ALLOWED = [
  /^\/user$/,
  /^\/users\/[^/]+\/repos$/,
  /^\/orgs\/[^/]+\/repos$/,
  /^\/repos\/[^/]+\/[^/]+$/,
  /^\/repos\/[^/]+\/[^/]+\/branches$/,
  /^\/repos\/[^/]+\/[^/]+\/deployments(\/\d+(\/statuses)?)?$/,
  /^\/repos\/[^/]+\/[^/]+\/releases(\/latest)?$/,
  /^\/repos\/[^/]+\/[^/]+\/actions\/workflows(\/[^/]+(\/(runs|dispatches))?)?$/,
  /^\/repos\/[^/]+\/[^/]+\/actions\/runs(\/\d+)?$/,
];

export function assertAllowedPath(path: string): void {
  if (/\/secrets(\/|$)/.test(path) || !ALLOWED.some((re) => re.test(path)))
    throw new ConnectorError('invalid_config', `GitHub path ${path} is not allowed for this connector`);
}

/** At most 10 pages of 100 repositories; details for the first 50. */
const REPO_PAGES = 10;
const DETAIL_REPOS = 50;

interface Repo {
  id: number;
  full_name: string;
  default_branch?: string;
  visibility?: string;
  private?: boolean;
  html_url?: string;
  archived?: boolean;
}

/**
 * GitHub (WB-06 UC-06-05/06) with a fine-grained personal access token (read: Metadata,
 * Actions, Deployments, Contents; Actions write only for workflow dispatch). Repositories,
 * workflows, deployments, and releases become observations; signed webhooks become change events.
 */
export function createGithubConnector(opts: GithubOptions = {}): Connector {
  const base = (opts.baseUrl ?? 'https://api.github.com').replace(/\/+$/, '');
  const prefix = new URL(base).pathname.replace(/\/+$/, '');
  const raw = createHttpClient({
    ...(opts.fetch ? { fetch: opts.fetch } : { destination: opts.destination ?? { allowPrivate: false } }),
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
  });
  /** Every call, including the M16 dispatch adapter's, passes the path allowlist. */
  const http: HttpLike = {
    request(url, init) {
      assertAllowedPath(new URL(url).pathname.slice(prefix.length) || '/');
      return raw.request(url, init as RequestInit);
    },
  };

  async function get<T>(ctx: ExecutionContext, path: string): Promise<{ status: number; body: T | null }> {
    const { token } = await ctx.credentials();
    const res = await http.request(`${base}${path}`, {
      headers: {
        authorization: `Bearer ${token ?? ''}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'product-control-plane',
      },
    });
    const r = res as unknown as { status: number; headers: Headers; json<U>(): U };
    if (r.status === 401) throw new ConnectorError('reauthorization_required', 'GitHub rejected the token');
    if (r.status === 403 && r.headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(r.headers.get('x-ratelimit-reset') ?? 0);
      throw new ConnectorError('rate_limited', 'GitHub rate limit exhausted', {
        retryAfterSeconds: Math.max(1, reset - Math.floor(Date.now() / 1000)),
      });
    }
    let body: T | null = null;
    try {
      body = r.json<T>();
    } catch {
      body = null;
    }
    return { status: r.status, body };
  }

  const owner = (ctx: ExecutionContext) => {
    const o = String(ctx.config.owner ?? '');
    if (!/^[A-Za-z0-9-]{1,39}$/.test(o))
      throw new ConnectorError('invalid_config', 'config.owner must be a GitHub user or organization');
    return o;
  };

  async function repos(ctx: ExecutionContext): Promise<{ found: Repo[]; missing: string[] }> {
    const o = owner(ctx);
    const named = Array.isArray(ctx.config.repositories) ? (ctx.config.repositories as string[]) : null;
    if (named) {
      const found: Repo[] = [];
      const missing: string[] = [];
      for (const name of named.slice(0, 100)) {
        const r = await get<Repo>(ctx, `/repos/${o}/${encodeURIComponent(name)}`);
        if (r.status === 200 && r.body) found.push(r.body);
        else missing.push(`Repository access: ${o}/${name}`);
      }
      return { found, missing };
    }
    const found: Repo[] = [];
    for (let page = 1; page <= REPO_PAGES; page++) {
      let r = await get<Repo[]>(ctx, `/users/${o}/repos?per_page=100&page=${page}`);
      if (r.status === 404) r = await get<Repo[]>(ctx, `/orgs/${o}/repos?per_page=100&page=${page}`);
      if (r.status >= 400) {
        if (page === 1) return { found, missing: [`Repository access: ${o}`] };
        break;
      }
      const list = r.body ?? [];
      found.push(...list);
      if (list.length < 100) break;
    }
    return { found, missing: [] };
  }

  const observation = (
    ctx: ExecutionContext,
    resourceType: string,
    externalId: string,
    attributes: Record<string, unknown>,
    source: Observation['source'] = 'provider_api',
  ): Observation => ({
    connectionId: ctx.connectionId,
    source,
    provider: 'github',
    resourceType,
    externalId,
    attributes,
    observedAt: new Date().toISOString(),
    method: source === 'webhook' ? 'webhook' : 'github_api',
    confidence: 1,
    evidence: { api: 'github/rest' },
  });

  const change = (
    ctx: ExecutionContext,
    a: {
      kind: string;
      title: string;
      externalId: string;
      occurredAt?: string;
      url?: string;
      actor?: string;
      repo: string;
    },
  ): Observation =>
    observation(
      ctx,
      'change_event',
      a.externalId,
      {
        kind: a.kind,
        title: a.title.slice(0, 300),
        externalId: a.externalId,
        occurredAt: a.occurredAt ?? new Date().toISOString(),
        ...(a.url ? { url: a.url } : {}),
        ...(a.actor ? { actor: a.actor } : {}),
        repository: a.repo,
      },
      'webhook',
    );

  return {
    type: 'github',
    version: '1.0.0',
    displayName: 'GitHub',
    executionLocations: ['cloud'],
    credentialFields: [
      { name: 'token', label: 'Fine-grained personal access token', secret: true },
      { name: 'webhookSecret', label: 'Webhook secret', secret: true, required: false },
    ],
    capabilities: () => ['config_validation', 'validate', 'discover', 'health', 'events', 'actions'],
    configSchema: () => ({
      type: 'object',
      required: ['owner'],
      properties: {
        owner: { type: 'string', maxLength: 39 },
        repositories: { type: 'array', items: { type: 'string', maxLength: 100 }, maxItems: 100 },
      },
      additionalProperties: false,
    }),
    validateConfig(config) {
      const c = (config ?? {}) as { owner?: unknown; repositories?: unknown };
      const errors: string[] = [];
      if (typeof c.owner !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(c.owner)) errors.push('owner');
      if (
        c.repositories !== undefined &&
        (!Array.isArray(c.repositories) ||
          c.repositories.some((r) => typeof r !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(r)))
      )
        errors.push('repositories');
      return errors.length ? { ok: false, errors } : { ok: true };
    },

    async validate(ctx) {
      const me = await get<{ login?: string }>(ctx, '/user');
      if (me.status >= 400)
        throw new ConnectorError('reauthorization_required', 'GitHub did not accept the token');
      const { missing } = await repos(ctx);
      return {
        ok: missing.length === 0,
        ...(me.body?.login ? { accountId: me.body.login } : {}),
        ...(missing.length ? { missingPermissions: missing } : {}),
      };
    },

    async discover(ctx) {
      const { found } = await repos(ctx);
      const observations: Observation[] = [];
      for (const [i, r] of found.filter((x) => !x.archived).entries()) {
        observations.push(
          observation(ctx, 'github_repository', String(r.id), {
            name: r.full_name,
            fullName: r.full_name,
            defaultBranch: r.default_branch ?? null,
            visibility: r.visibility ?? (r.private ? 'private' : 'public'),
            url: r.html_url ?? null,
          }),
        );
        if (i >= DETAIL_REPOS) continue;
        const wf = await get<{
          workflows?: Array<{ id: number; name: string; path: string; state: string }>;
        }>(ctx, `/repos/${r.full_name}/actions/workflows?per_page=50`);
        for (const w of wf.body?.workflows ?? [])
          observations.push(
            observation(ctx, 'github_workflow', String(w.id), {
              name: `${r.full_name} · ${w.name}`,
              repository: r.full_name,
              path: w.path,
              file: w.path.split('/').pop(),
              state: w.state,
            }),
          );
        const deps = await get<
          Array<{ id: number; environment: string; ref: string; sha?: string; created_at?: string }>
        >(ctx, `/repos/${r.full_name}/deployments?per_page=5`);
        for (const d of Array.isArray(deps.body) ? deps.body : [])
          observations.push(
            observation(ctx, 'github_deployment', String(d.id), {
              name: `${r.full_name} → ${d.environment}`,
              repository: r.full_name,
              environment: d.environment,
              ref: d.ref,
              createdAt: d.created_at ?? null,
            }),
          );
        const rel = await get<
          Array<{ id: number; tag_name: string; published_at?: string; html_url?: string }>
        >(ctx, `/repos/${r.full_name}/releases?per_page=1`);
        for (const x of Array.isArray(rel.body) ? rel.body : [])
          observations.push(
            observation(ctx, 'github_release', String(x.id), {
              name: `${r.full_name} ${x.tag_name}`,
              repository: r.full_name,
              tag: x.tag_name,
              publishedAt: x.published_at ?? null,
              url: x.html_url ?? null,
            }),
          );
      }
      return { observations };
    },

    async health(ctx) {
      const me = await get<{ login?: string }>(ctx, '/user');
      return me.status === 200
        ? { ok: true, data: { login: me.body?.login ?? null } }
        : { ok: false, detail: `GitHub answered ${me.status}` };
    },

    verifyWebhook(req, credentials) {
      const secret = credentials.webhookSecret;
      const sent = req.headers['x-hub-signature-256'] ?? '';
      if (!secret || !safeEqual(sent, `sha256=${hmacSha256Hex(secret, req.rawBody)}`)) return { ok: false };
      return {
        ok: true,
        deliveryId: req.headers['x-github-delivery'] ?? '',
        eventType: req.headers['x-github-event'] ?? 'unknown',
      };
    },

    async ingestEvent(ctx, event) {
      const p = (event.payload ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      const repo = String(p.repository?.full_name ?? '');
      switch (event.eventType) {
        case 'deployment_status': {
          const s = p.deployment_status ?? {};
          const d = p.deployment ?? {};
          if (!['success', 'failure', 'error'].includes(s.state)) return [];
          const ok = s.state === 'success';
          return [
            change(ctx, {
              kind: ok ? 'deployment' : 'deployment_failed',
              title: `${ok ? 'Deployed' : 'Deployment failed:'} ${d.ref} to ${d.environment} (${repo})`,
              externalId: `${d.id}:${s.state}`,
              occurredAt: s.created_at,
              url: s.target_url ?? undefined,
              actor: s.creator?.login,
              repo,
            }),
          ];
        }
        case 'workflow_run': {
          const w = p.workflow_run ?? {};
          if (p.action !== 'completed' || !['failure', 'timed_out', 'startup_failure'].includes(w.conclusion))
            return [];
          return [
            change(ctx, {
              kind: 'workflow_failed',
              title: `Workflow ${w.name} failed on ${w.head_branch} (${repo})`,
              externalId: String(w.id),
              occurredAt: w.updated_at,
              url: w.html_url,
              actor: w.actor?.login,
              repo,
            }),
          ];
        }
        case 'release': {
          const r = p.release ?? {};
          if (p.action !== 'published') return [];
          return [
            change(ctx, {
              kind: 'release',
              title: `Released ${r.tag_name} (${repo})`,
              externalId: String(r.id),
              occurredAt: r.published_at,
              url: r.html_url,
              actor: r.author?.login,
              repo,
            }),
          ];
        }
        case 'push': {
          const branch = p.repository?.default_branch;
          if (!branch || p.ref !== `refs/heads/${branch}`) return [];
          const n = Array.isArray(p.commits) ? p.commits.length : 0;
          return [
            change(ctx, {
              kind: 'push',
              title: `${n} commit${n === 1 ? '' : 's'} pushed to ${branch} (${repo})`,
              externalId: String(p.after),
              url: p.compare,
              actor: p.pusher?.name,
              repo,
            }),
          ];
        }
        case 'github_app_authorization':
        case 'installation':
          return p.action === 'revoked' || p.action === 'deleted'
            ? [observation(ctx, 'connection_revoked', event.eventType, {}, 'webhook')]
            : [];
        default:
          return [];
      }
    },

    /** `workflow_dispatch` (M16 UC-16-07) for an allowlisted workflow and ref. */
    async executeAction(ctx, action): Promise<AdapterResult> {
      if (action.kind !== 'workflow_dispatch')
        throw new ConnectorError('invalid_config', `unknown action ${String(action.kind)}`);
      const { token } = await ctx.credentials();
      if (!token) throw new ConnectorError('reauthorization_required', 'no GitHub token stored');
      return githubDispatch(http, {
        token,
        repo: String(action.repo),
        workflow: String(action.workflow),
        ref: String(action.ref),
        now: () => new Date(),
        ...(opts.sleep ? { sleep: opts.sleep } : {}),
        baseUrl: base,
      });
    },
  };
}

export const githubConnector = createGithubConnector();
