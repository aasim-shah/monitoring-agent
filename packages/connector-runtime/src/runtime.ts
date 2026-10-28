import {
  ConnectorError,
  redactSecrets,
  transition,
  type Connector,
  type ConnectorRegistry,
  type ExecutionContext,
  type SyncResult,
  type WebhookRequest,
} from '@pcp/connector-sdk';
import type { Prisma, PrismaClient } from '@pcp/database';
import type { KeyRing } from '@pcp/secrets';
import type { ConnectionStatus, DiscoveryPage, Observation, TenantContext } from '@pcp/shared-contracts';
import { withTenant } from '@pcp/tenant-security';
import { decryptCredentials } from './secrets.js';

const OPERATION_TIMEOUT_MS = 30_000;
/** Managed (cloud) connections with a health check are checked every 5 minutes. */
export const HEALTH_EVERY_SECONDS = 300;
/** KPI sources update at most hourly (GA4 processing, quotas). */
export const SYNC_EVERY_SECONDS = 3600;
const MAX_DETAIL_BYTES = 256 * 1024;

/** The connection does not exist for this caller (other tenant or out of product scope). */
export class NotFoundError extends Error {
  constructor() {
    super('connection not found');
    this.name = 'NotFoundError';
  }
}

export interface ValidationOutcome {
  status: ConnectionStatus;
  reason?: string;
  message?: string;
  missingPermissions?: string[];
  retryAfterSeconds?: number;
}

type LoadedConnection = Prisma.ConnectionGetPayload<{
  include: { secret: true; scopes: { select: { productId: true } } };
}>;

/**
 * Executes connector operations for one tenant (ADR 0008): loads the connection
 * inside the caller's RLS context and product scope, decrypts credentials on
 * demand, and redacts them from every error it surfaces or stores.
 */
export class ConnectorRuntime {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly registry: ConnectorRegistry,
    private readonly keys: KeyRing,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private load(ctx: TenantContext, connectionId: string): Promise<LoadedConnection> {
    return withTenant(this.prisma, ctx, async (tx) => {
      const c = await tx.connection.findUnique({
        where: { id: connectionId },
        include: { secret: true, scopes: { select: { productId: true } } },
      });
      if (!c) throw new NotFoundError();
      const allowed = ctx.productIds;
      if (allowed !== 'all' && !c.scopes.some((s) => allowed.includes(s.productId)))
        throw new NotFoundError();
      return c;
    });
  }

  /** Runs `fn` with an execution context; any error comes back as a redacted ConnectorError. */
  private async execute<T>(
    ctx: TenantContext,
    c: LoadedConnection,
    fn: (e: ExecutionContext) => Promise<T>,
  ): Promise<T> {
    // Decrypt up front: corrupted or misplaced credentials must surface even if the connector never reads them.
    let creds: Record<string, string> | undefined;
    if (c.secret) {
      try {
        creds = decryptCredentials(c.secret.ciphertext, c.organizationId, c.id, this.keys);
      } catch {
        throw new ConnectorError(
          'reauthorization_required',
          'stored credentials could not be decrypted; reconnect',
        );
      }
    }
    const secrets = creds ? Object.values(creds) : [];
    const exec: ExecutionContext = {
      authenticatedOrganizationId: ctx.organizationId,
      connectionId: c.id,
      executionLocation: c.executionLocation,
      requestId: ctx.requestId,
      deadline: new Date(this.now().getTime() + OPERATION_TIMEOUT_MS).toISOString(),
      config: (c.config ?? {}) as Record<string, unknown>,
      credentials: async () => {
        if (!creds) throw new ConnectorError('reauthorization_required', 'no credentials stored');
        return creds;
      },
      grantedScopes: c.grantedScopes ?? [],
    };
    try {
      return await fn(exec);
    } catch (err) {
      const message = redactSecrets(err instanceof Error ? err.message : String(err), secrets);
      if (err instanceof ConnectorError) {
        throw new ConnectorError(err.reason, message, { retryAfterSeconds: err.retryAfterSeconds });
      }
      throw new ConnectorError('provider_unavailable', message);
    }
  }

  /** Daily KPI values for the connection's product-scoped resources (M13b). */
  async sync(ctx: TenantContext, connectionId: string, input: { days: number }): Promise<SyncResult> {
    const c = await this.load(ctx, connectionId);
    if (c.status !== 'connected' && c.status !== 'degraded')
      throw new ConnectorError('invalid_config', `the connection is ${c.status}`);
    const connector = this.registry.get(c.provider);
    if (!connector.sync) throw new ConnectorError('invalid_config', `${c.provider} does not sync`);
    const scopes = await withTenant(this.prisma, ctx, (tx) =>
      tx.connectionResourceScope.findMany({
        where: { connectionId },
        select: { resourceType: true, externalId: true },
        distinct: ['resourceType', 'externalId'],
      }),
    );
    if (!scopes.length) return { points: [], gaps: [] };
    return this.execute(ctx, c, (e) => connector.sync!(e, { scopes, days: input.days }));
  }

  /**
   * Marks a revoked grant (`invalid_grant`): degraded with reauthorization_required. Returns true
   * only when this call made the change, so the owner is told once (WB-08 UC-08-10).
   */
  async markReauthorizationRequired(ctx: TenantContext, connectionId: string): Promise<boolean> {
    return withTenant(this.prisma, ctx, async (tx) => {
      const { count } = await tx.connection.updateMany({
        where: {
          id: connectionId,
          status: { in: ['connected', 'degraded'] },
          OR: [{ statusReason: null }, { statusReason: { not: 'reauthorization_required' } }],
        },
        data: { status: 'degraded', statusReason: 'reauthorization_required' },
      });
      return count === 1;
    });
  }

  async discover(ctx: TenantContext, connectionId: string): Promise<DiscoveryPage> {
    const c = await this.load(ctx, connectionId);
    const connector = this.registry.get(c.provider);
    if (!connector.discover)
      throw new ConnectorError('invalid_config', `${c.provider} does not support discovery`);
    return this.execute(ctx, c, (e) => connector.discover!(e));
  }

  /**
   * Runs a provider-specific operation that is not part of the connector SDK (e.g. Google's access
   * check for a service account) with the same loading, decryption, and redaction as the others.
   */
  async run<T>(
    ctx: TenantContext,
    connectionId: string,
    fn: (connector: Connector, e: ExecutionContext) => Promise<T>,
  ): Promise<T> {
    const c = await this.load(ctx, connectionId);
    const connector = this.registry.get(c.provider);
    return this.execute(ctx, c, (e) => fn(connector, e));
  }

  /**
   * A provider webhook for one connection (spec §7.7): only a connected or degraded connection
   * whose connector verifies the signature with this connection's own secret gets its event
   * normalized. Everything else looks the same to the caller: not verified.
   */
  async webhook(
    ctx: TenantContext,
    connectionId: string,
    req: WebhookRequest,
  ): Promise<
    | { verified: false }
    | { verified: true; provider: string; deliveryId: string; eventType: string; observations: Observation[] }
  > {
    const c = await this.load(ctx, connectionId).catch(() => null);
    if (!c || (c.status !== 'connected' && c.status !== 'degraded')) return { verified: false };
    const connector = this.registry.get(c.provider);
    if (!connector.verifyWebhook || !connector.ingestEvent || !c.secret) return { verified: false };
    let creds: Record<string, string>;
    try {
      creds = decryptCredentials(c.secret.ciphertext, c.organizationId, c.id, this.keys);
    } catch {
      return { verified: false };
    }
    const check = connector.verifyWebhook(req, creds);
    if (!check.ok) return { verified: false };
    const observations = await this.execute(ctx, c, (e) =>
      connector.ingestEvent!(e, { eventType: check.eventType, headers: req.headers, payload: req.payload }),
    );
    return {
      verified: true,
      provider: c.provider,
      deliveryId: check.deliveryId,
      eventType: check.eventType,
      observations,
    };
  }

  /** Runs a provider action approved through M16 (cache purge, workflow dispatch). */
  async executeAction(
    ctx: TenantContext,
    connectionId: string,
    action: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const c = await this.load(ctx, connectionId);
    if (c.status !== 'connected' && c.status !== 'degraded')
      throw new ConnectorError('invalid_config', `the connection is ${c.status}`);
    const connector = this.registry.get(c.provider);
    if (!connector.executeAction) throw new ConnectorError('invalid_config', `${c.provider} has no actions`);
    return this.execute(ctx, c, (e) => connector.executeAction!(e, action));
  }

  /** Validates credentials and applies the lifecycle transition, health record, and reason. */
  async validate(ctx: TenantContext, connectionId: string): Promise<ValidationOutcome> {
    const c = await this.load(ctx, connectionId);
    if (c.status === 'disconnected' || c.status === 'revoked') return { status: c.status };
    const connector = this.registry.get(c.provider);

    let outcome: ValidationOutcome;
    try {
      const result = await this.execute(ctx, c, (e) => connector.validate(e));
      outcome = result.ok
        ? { status: transition(c.status, c.status === 'degraded' ? 'recovered' : 'validated') }
        : {
            status: transition(c.status, 'validation_failed'),
            reason: 'permission_denied',
            message: 'missing permissions',
            missingPermissions: result.missingPermissions,
          };
    } catch (err) {
      const e = err as ConnectorError;
      outcome =
        e.reason === 'rate_limited'
          ? {
              status: c.status,
              reason: 'rate_limited',
              message: e.message,
              retryAfterSeconds: e.retryAfterSeconds,
            }
          : { status: transition(c.status, 'validation_failed'), reason: e.reason, message: e.message };
    }

    await withTenant(this.prisma, ctx, async (tx) => {
      // A connection deleted meanwhile stays deleted (never revived by a late job). The status
      // condition sits in the UPDATE itself so a delete committing mid-validation still wins.
      const { count } = await tx.connection.updateMany({
        where: { id: c.id, status: { notIn: ['disconnected', 'revoked'] } },
        data: { status: outcome.status, statusReason: outcome.reason ?? null, lastValidatedAt: this.now() },
      });
      if (count === 0) {
        const current = await tx.connection.findUnique({ where: { id: c.id }, select: { status: true } });
        outcome = { status: current?.status ?? 'disconnected' };
        return;
      }
      await tx.connectionHealth.create({
        data: {
          organizationId: c.organizationId,
          connectionId: c.id,
          checkedAt: this.now(),
          ok: !outcome.reason,
          reason: outcome.reason ?? null,
          detail: outcome.missingPermissions
            ? JSON.stringify({ missingPermissions: outcome.missingPermissions })
            : (outcome.message ?? null),
        },
      });
      // A connected cloud connection with a health check gets a schedule (the worker's reconciler picks it up).
      if (outcome.status === 'connected' && c.executionLocation === 'cloud' && connector.health)
        await tx.jobDefinition.upsert({
          where: {
            organizationId_kind_entityId: {
              organizationId: c.organizationId,
              kind: 'connection-health',
              entityId: c.id,
            },
          },
          create: {
            organizationId: c.organizationId,
            kind: 'connection-health',
            entityId: c.id,
            everySeconds: HEALTH_EVERY_SECONDS,
          },
          update: { enabled: true, everySeconds: HEALTH_EVERY_SECONDS },
        });
      // KPI connectors (Google) also sync hourly.
      if (outcome.status === 'connected' && c.executionLocation === 'cloud' && connector.sync)
        await tx.jobDefinition.upsert({
          where: {
            organizationId_kind_entityId: {
              organizationId: c.organizationId,
              kind: 'connection-sync',
              entityId: c.id,
            },
          },
          create: {
            organizationId: c.organizationId,
            kind: 'connection-sync',
            entityId: c.id,
            everySeconds: SYNC_EVERY_SECONDS,
          },
          update: { enabled: true, everySeconds: SYNC_EVERY_SECONDS },
        });
    });
    return outcome;
  }

  /**
   * Runs the connector's health check and records it (WB-07 UC-07-04): `data` is stored as
   * JSON; a failure degrades a connected connection and a later success recovers it, except
   * when a person must act first (permission_denied, reauthorization_required).
   */
  async health(
    ctx: TenantContext,
    connectionId: string,
  ): Promise<{ ok: boolean; reason?: string; data?: Record<string, unknown> }> {
    const c = await this.load(ctx, connectionId);
    if (c.status === 'disconnected' || c.status === 'revoked') return { ok: false, reason: c.status };
    const connector = this.registry.get(c.provider);
    if (!connector.health) throw new ConnectorError('invalid_config', `${c.provider} has no health check`);
    let result: { ok: boolean; reason?: string; message?: string; data?: Record<string, unknown> };
    try {
      const h = await this.execute(ctx, c, (e) => connector.health!(e));
      result = {
        ok: h.ok,
        data: h.data,
        ...(h.ok ? {} : { reason: 'provider_unavailable', message: h.detail }),
      };
    } catch (err) {
      const e = err as ConnectorError;
      result = { ok: false, reason: e.reason, message: e.message };
    }
    const detail = JSON.stringify(
      result.ok ? (result.data ?? {}) : { error: result.message ?? result.reason },
    );
    await withTenant(this.prisma, ctx, async (tx) => {
      await tx.connectionHealth.create({
        data: {
          organizationId: c.organizationId,
          connectionId: c.id,
          checkedAt: this.now(),
          ok: result.ok,
          reason: result.ok ? null : (result.reason ?? null),
          detail: Buffer.byteLength(detail) > MAX_DETAIL_BYTES ? JSON.stringify({ truncated: true }) : detail,
        },
      });
      const sticky = ['permission_denied', 'reauthorization_required'];
      const next =
        !result.ok && c.status === 'connected'
          ? { status: transition(c.status, 'degraded'), statusReason: result.reason ?? null }
          : result.ok && c.status === 'degraded' && !sticky.includes(c.statusReason ?? '')
            ? { status: transition(c.status, 'recovered'), statusReason: null }
            : null;
      if (next)
        await tx.connection.updateMany({
          where: { id: c.id, status: { notIn: ['disconnected', 'revoked'] } },
          data: next,
        });
    });
    return {
      ok: result.ok,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.data ? { data: result.data } : {}),
    };
  }
}
