import {
  ConnectorError,
  redactSecrets,
  transition,
  type ConnectorRegistry,
  type ExecutionContext,
} from '@pcp/connector-sdk';
import type { Prisma, PrismaClient } from '@pcp/database';
import type { KeyRing } from '@pcp/secrets';
import type { ConnectionStatus, DiscoveryPage, TenantContext } from '@pcp/shared-contracts';
import { withTenant } from '@pcp/tenant-security';
import { decryptCredentials } from './secrets.js';

const OPERATION_TIMEOUT_MS = 30_000;

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

  async discover(ctx: TenantContext, connectionId: string): Promise<DiscoveryPage> {
    const c = await this.load(ctx, connectionId);
    const connector = this.registry.get(c.provider);
    if (!connector.discover)
      throw new ConnectorError('invalid_config', `${c.provider} does not support discovery`);
    return this.execute(ctx, c, (e) => connector.discover!(e));
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
      // A connection deleted meanwhile stays deleted (never revived by a late job).
      const current = await tx.connection.findUnique({ where: { id: c.id }, select: { status: true } });
      if (!current || current.status === 'disconnected' || current.status === 'revoked') {
        outcome = { status: current?.status ?? 'disconnected' };
        return;
      }
      await tx.connection.update({
        where: { id: c.id },
        data: { status: outcome.status, statusReason: outcome.reason ?? null, lastValidatedAt: this.now() },
      });
      await tx.connectionHealth.create({
        data: {
          organizationId: c.organizationId,
          connectionId: c.id,
          checkedAt: this.now(),
          ok: !outcome.reason,
          reason: outcome.reason ?? null,
          detail: outcome.message ?? null,
        },
      });
    });
    return outcome;
  }
}
