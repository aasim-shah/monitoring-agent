import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { can, type TenantContext } from '@pcp/shared-contracts';
import type { PrismaClient } from '@pcp/database';
import { GOOGLE_DATA_SCOPES, GOOGLE_IDENTITY_SCOPES, missingScopes } from '@pcp/connectors-google';
import { withTenant } from '@pcp/tenant-security';
import type { Redis } from 'ioredis';
import { ApiException, notFound } from '../../common/errors.js';
import type { AppConfig } from '../../config.js';
import { APP_CONFIG, PRISMA, REDIS } from '../../tokens.js';
import { GOOGLE_AUTHORIZE_URL, GOOGLE_HTTP, type GoogleHttp } from '../identity/google-login.service.js';
import { randomToken } from '../identity/tokens.js';
import { ConnectionsService } from './connections.service.js';

const STATE_TTL_SECONDS = 600;

interface StoredState {
  userId: string;
  organizationId: string;
  connectionId: string;
  productId: string;
  verifier: string;
}

const invalidState = () =>
  new ApiException(
    400,
    'invalid_state',
    'This Google sign-in has expired or was not started here; start again',
  );

/** Reads the email claim of an ID token received directly from Google's token endpoint over TLS. */
function emailFrom(idToken: unknown): string | null {
  if (typeof idToken !== 'string') return null;
  try {
    const claims = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as {
      email?: unknown;
    };
    return typeof claims.email === 'string' ? claims.email.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Google data connections (WB-08 UC-08-01/02): authorization code with PKCE, a state bound to the
 * member and the connection (10 minutes, single use), offline access, and incremental grants.
 */
@Injectable()
export class GoogleConnectService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(GOOGLE_HTTP) private readonly http: GoogleHttp,
    private readonly connections: ConnectionsService,
  ) {}

  private get client() {
    const g = this.config.google;
    if (!g?.connections)
      throw new ApiException(
        404,
        'google_connections_not_configured',
        'Google connections are not configured',
      );
    return { clientId: g.clientId, clientSecret: g.clientSecret, ...g.connections };
  }

  async start(ctx: TenantContext, id: string, input: { productId: string; missingOnly: boolean }) {
    const client = this.client;
    const c = await this.connections.get(ctx, id);
    if (c.provider !== 'google') throw new ApiException(400, 'not_google', 'This is not a Google connection');
    const product = await withTenant(this.prisma, ctx, (tx) =>
      tx.product.findUnique({ where: { id: input.productId }, select: { id: true } }),
    );
    if (!product || !can(ctx, 'connection.configure', { productId: product.id })) throw notFound();
    if (ctx.actor.kind !== 'user') throw notFound();

    const state = randomToken();
    const verifier = randomToken();
    const stored: StoredState = {
      userId: ctx.actor.userId,
      organizationId: ctx.organizationId,
      connectionId: id,
      productId: product.id,
      verifier,
    };
    await this.redis.set(`oauth:gconn:${state}`, JSON.stringify(stored), 'EX', STATE_TTL_SECONDS);
    const scopes = input.missingOnly ? missingScopes(c.grantedScopes) : GOOGLE_DATA_SCOPES;
    const url = new URL(GOOGLE_AUTHORIZE_URL);
    url.search = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: client.redirectUri,
      response_type: 'code',
      scope: [...scopes, ...GOOGLE_IDENTITY_SCOPES].join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString();
    return { url: url.toString() };
  }

  /** Returns where to send the browser: back to the connection page. */
  async callback(
    userId: string,
    requestId: string,
    query: { state: string; code?: string; error?: string },
  ): Promise<string> {
    const client = this.client;
    const raw = await this.redis.getdel(`oauth:gconn:${query.state}`);
    if (!raw) throw invalidState();
    const s = JSON.parse(raw) as StoredState;
    if (s.userId !== userId) throw invalidState();
    const ctx = await this.memberContext(userId, s.organizationId, requestId);
    if (!ctx || !can(ctx, 'connection.configure', { productId: s.productId })) throw invalidState();

    const page = `${this.config.appOrigin}/orgs/${s.organizationId}/products/${s.productId}/integrations/${s.connectionId}`;
    if (query.error || !query.code) return `${page}?google=cancelled`;

    const res = await this.http.fetch(client.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: query.code,
        client_id: client.clientId,
        client_secret: client.clientSecret,
        redirect_uri: client.redirectUri,
        grant_type: 'authorization_code',
        code_verifier: s.verifier,
      }),
    });
    if (!res.ok) return `${page}?google=error`;
    const token = (await res.json()) as { refresh_token?: string; scope?: string; id_token?: string };
    const granted = (token.scope ?? '').split(' ').filter((x) => GOOGLE_DATA_SCOPES.includes(x));
    await this.connections.completeOAuth(ctx, s.connectionId, {
      ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
      grantedScopes: granted,
      accountEmail: emailFrom(token.id_token),
    });
    return `${page}?google=connected`;
  }

  /** The member's tenant context in the organization the flow started in, or null if they left. */
  private async memberContext(
    userId: string,
    organizationId: string,
    requestId: string,
  ): Promise<TenantContext | null> {
    const [m] = await this.prisma.$queryRaw<
      Array<{ organization_id: string; role: string; all_products: boolean; product_ids: string[] }>
    >`SELECT organization_id, role, all_products, product_ids FROM pcp_user_memberships(${userId}::uuid)
      WHERE organization_id = ${organizationId}::uuid`;
    if (!m) return null;
    return {
      organizationId: m.organization_id,
      actor: { kind: 'user', userId },
      roles: [m.role as TenantContext['roles'][number]],
      productIds: m.all_products ? 'all' : m.product_ids,
      environmentIds: 'all',
      requestId,
    };
  }
}
