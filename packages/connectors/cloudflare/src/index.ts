import { cloudflarePurge, type AdapterResult } from '@pcp/automation';
import {
  bodyDigest,
  ConnectorError,
  createHttpClient,
  safeEqual,
  type Connector,
  type DestinationOptions,
  type ExecutionContext,
} from '@pcp/connector-sdk';
import type { Observation } from '@pcp/shared-contracts';

export interface CloudflareOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  destination?: DestinationOptions;
  sleep?: (ms: number) => Promise<void>;
}

/** At most 50 zones per page × 50 pages, and 1,000 DNS records per zone. */
const ZONE_PAGES = 50;
const RECORD_PAGES = 10;

interface Envelope<T> {
  success?: boolean;
  result?: T;
  result_info?: { page?: number; total_pages?: number };
  errors?: Array<{ code?: number; message?: string }>;
}

interface Zone {
  id: string;
  name: string;
  status: string;
  plan?: { name?: string };
  name_servers?: string[];
  account?: { id?: string; name?: string };
}

const message = (e: Envelope<unknown>) =>
  e.errors
    ?.map((x) => x.message)
    .filter(Boolean)
    .join('; ') || 'request failed';

/**
 * Cloudflare (WB-06 UC-06-01..03): a scoped API token, read-only unless cache purge is enabled
 * (BR-06-01). Zones, DNS records, and certificate packs become observations; notification
 * webhooks become DNS and security change events; purge runs through M16 approvals.
 */
export function createCloudflareConnector(opts: CloudflareOptions = {}): Connector {
  const base = (opts.baseUrl ?? 'https://api.cloudflare.com/client/v4').replace(/\/+$/, '');
  const http = createHttpClient({
    ...(opts.fetch ? { fetch: opts.fetch } : { destination: opts.destination ?? { allowPrivate: false } }),
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
  });

  /** One GET; 401 needs a new token, 403 is a missing permission (returned, not thrown). */
  async function get<T>(ctx: ExecutionContext, path: string): Promise<{ status: number; body: Envelope<T> }> {
    const { apiToken } = await ctx.credentials();
    const res = await http.request(`${base}${path}`, { headers: { authorization: `Bearer ${apiToken}` } });
    let body: Envelope<T> = {};
    try {
      body = res.json<Envelope<T>>();
    } catch {
      body = {};
    }
    if (res.status === 401)
      throw new ConnectorError('reauthorization_required', `Cloudflare: ${message(body)}`);
    return { status: res.status, body };
  }

  async function paged<T>(
    ctx: ExecutionContext,
    path: string,
    perPage: number,
    pages: number,
  ): Promise<T[] | null> {
    const out: T[] = [];
    for (let page = 1; page <= pages; page++) {
      const sep = path.includes('?') ? '&' : '?';
      const { status, body } = await get<T[]>(ctx, `${path}${sep}per_page=${perPage}&page=${page}`);
      if (status === 403) return page === 1 ? null : out;
      if (status >= 400 || !body.success)
        throw new ConnectorError('provider_unavailable', `Cloudflare: ${message(body)}`);
      out.push(...(body.result ?? []));
      if (page >= (body.result_info?.total_pages ?? 1)) break;
    }
    return out;
  }

  const observation = (
    ctx: ExecutionContext,
    resourceType: string,
    externalId: string,
    attributes: Record<string, unknown>,
  ): Observation => ({
    connectionId: ctx.connectionId,
    source: 'provider_api',
    provider: 'cloudflare',
    resourceType,
    externalId,
    attributes,
    observedAt: new Date().toISOString(),
    method: 'cloudflare_api',
    confidence: 1,
    evidence: { api: 'cloudflare/v4' },
  });

  return {
    type: 'cloudflare',
    version: '1.0.0',
    displayName: 'Cloudflare',
    executionLocations: ['cloud'],
    credentialFields: [
      { name: 'apiToken', label: 'API token', secret: true },
      { name: 'webhookSecret', label: 'Notification webhook secret', secret: true, required: false },
    ],
    capabilities: () => ['validate', 'discover', 'health', 'events', 'actions'],
    configSchema: () => ({
      type: 'object',
      properties: { accountId: { type: 'string', maxLength: 64 } },
      additionalProperties: false,
    }),

    async validate(ctx) {
      const v = await get<{ status?: string }>(ctx, '/user/tokens/verify');
      if (v.status >= 400 || v.body.result?.status !== 'active')
        throw new ConnectorError(
          'reauthorization_required',
          `Cloudflare token is not active: ${message(v.body)}`,
        );
      const missing: string[] = [];
      const z = await get<Zone[]>(ctx, '/zones?per_page=1');
      if (z.status === 403) missing.push('Zone: Zone: Read');
      const zone = z.body.result?.[0];
      if (zone) {
        const d = await get(ctx, `/zones/${zone.id}/dns_records?per_page=1`);
        if (d.status === 403) missing.push('Zone: DNS: Read');
      }
      return {
        ok: missing.length === 0,
        ...(zone?.account?.id ? { accountId: zone.account.id } : {}),
        ...(missing.length ? { missingPermissions: missing } : {}),
      };
    },

    async discover(ctx) {
      const zones = (await paged<Zone>(ctx, '/zones', 50, ZONE_PAGES)) ?? [];
      const observations: Observation[] = [];
      for (const z of zones) {
        observations.push(
          observation(ctx, 'cloudflare_zone', z.id, {
            name: z.name,
            status: z.status,
            plan: z.plan?.name ?? null,
            nameServers: z.name_servers ?? [],
            account: z.account?.name ?? null,
          }),
        );
        const records =
          (await paged<{
            id: string;
            type: string;
            name: string;
            content: string;
            proxied?: boolean;
            ttl?: number;
          }>(ctx, `/zones/${z.id}/dns_records`, 100, RECORD_PAGES)) ?? [];
        for (const r of records)
          observations.push(
            observation(ctx, 'dns_record', r.id, {
              zoneId: z.id,
              zone: z.name,
              type: r.type,
              name: r.name,
              content: r.content,
              proxied: r.proxied ?? false,
              ttl: r.ttl ?? null,
            }),
          );
        const packs =
          (await paged<{
            id: string;
            status: string;
            hosts?: string[];
            certificates?: Array<{ expires_on?: string }>;
          }>(ctx, `/zones/${z.id}/ssl/certificate_packs?status=all`, 50, 1).catch(() => null)) ?? [];
        for (const p of packs)
          observations.push(
            observation(ctx, 'certificate_pack', p.id, {
              zoneId: z.id,
              zone: z.name,
              name: (p.hosts ?? [z.name])[0],
              status: p.status,
              hosts: p.hosts ?? [],
              expiresOn:
                p.certificates
                  ?.map((c) => c.expires_on)
                  .filter(Boolean)
                  .sort()[0] ?? null,
            }),
          );
      }
      return { observations };
    },

    async health(ctx) {
      const v = await get<{ status?: string }>(ctx, '/user/tokens/verify');
      return v.body.result?.status === 'active'
        ? { ok: true, data: { token: 'active' } }
        : { ok: false, detail: `token ${v.body.result?.status ?? 'unknown'}` };
    },

    /** Cloudflare notifications send the configured secret in `cf-webhook-auth`. */
    verifyWebhook(req, credentials) {
      const secret = credentials.webhookSecret;
      if (!secret || !safeEqual(req.headers['cf-webhook-auth'] ?? '', secret)) return { ok: false };
      const p = (req.payload ?? {}) as { alert_type?: string };
      return {
        ok: true,
        deliveryId: `cloudflare:${bodyDigest(req.rawBody)}`,
        eventType: p.alert_type ?? 'notification',
      };
    },

    async ingestEvent(ctx, event) {
      const p = (event.payload ?? {}) as {
        name?: string;
        text?: string;
        alert_type?: string;
        ts?: number;
        data?: unknown;
      };
      const type = p.alert_type ?? event.eventType;
      const occurredAt =
        typeof p.ts === 'number' ? new Date(p.ts * 1000).toISOString() : new Date().toISOString();
      return [
        {
          connectionId: ctx.connectionId,
          source: 'webhook',
          provider: 'cloudflare',
          resourceType: 'change_event',
          externalId: `${type}:${occurredAt}`,
          attributes: {
            kind: /dns/i.test(type) ? 'dns_change' : 'security_event',
            title: (p.text ?? p.name ?? type).slice(0, 300),
            occurredAt,
            externalId: `${type}:${occurredAt}`,
            alertType: type,
          },
          observedAt: new Date().toISOString(),
          method: 'webhook',
          confidence: 1,
          evidence: { alertType: type },
        },
      ];
    },

    /** `purge_cache` (M16 UC-16-06): URLs, or everything after two approvals. */
    async executeAction(ctx, action): Promise<AdapterResult> {
      if (action.kind !== 'purge_cache')
        throw new ConnectorError('invalid_config', `unknown action ${String(action.kind)}`);
      const { apiToken } = await ctx.credentials();
      if (!apiToken) throw new ConnectorError('reauthorization_required', 'no Cloudflare token stored');
      return cloudflarePurge(http, {
        token: apiToken,
        zoneId: String(action.zoneId),
        params: action.everything === true ? { everything: true } : { urls: action.urls as string[] },
        baseUrl: base,
      });
    },
  };
}

export const cloudflareConnector = createCloudflareConnector();
