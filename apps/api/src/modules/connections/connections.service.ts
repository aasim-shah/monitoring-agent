import { Inject, Injectable } from '@nestjs/common';
import { ConnectorError, transition, type ConnectorRegistry } from '@pcp/connector-sdk';
import { NotFoundError, storeCredentials, type ConnectorRuntime } from '@pcp/connector-runtime';
import type { Prisma, PrismaClient } from '@pcp/database';
import { enqueue, type JobKind, type Queues } from '@pcp/jobs';
import type { KeyRing } from '@pcp/secrets';
import type { ConnectionStatus, TenantContext } from '@pcp/shared-contracts';
import { withTenant } from '@pcp/tenant-security';
import { ApiException, notFound } from '../../common/errors.js';
import { KEY_RING, PRISMA } from '../../tokens.js';
import { PrivateOpsService } from './private-ops.service.js';
import { parseConnectionString, type ParsedConnection } from '@pcp/connectors-databases';

const DB_PROVIDERS = ['postgres', 'mysql', 'mongodb'];
import { AuditService } from '../auditing/audit.service.js';
import { CONNECTOR_REGISTRY, CONNECTOR_RUNTIME, QUEUES } from './registry.provider.js';

/** Providers whose credentials come only from an OAuth callback (M13b). */
const OAUTH_PROVIDERS = ['google'];
const TERMINAL: ConnectionStatus[] = ['disconnected', 'revoked'];

const withScopes = { scopes: { orderBy: { createdAt: 'asc' } } } satisfies Prisma.ConnectionInclude;
type ConnectionWithScopes = Prisma.ConnectionGetPayload<{ include: typeof withScopes }>;

export interface ScopeInput {
  externalId: string;
  resourceType: string;
  name: string;
  productId: string;
  environmentId?: string;
}

const closed = () => new ApiException(409, 'connection_closed', 'This connection is disconnected');

/** Maps connector failures to API errors; messages are already redacted by the runtime. */
function connectorFailure(err: unknown): never {
  if (err instanceof NotFoundError) throw notFound();
  if (err instanceof ConnectorError) {
    if (err.reason === 'rate_limited') {
      const retry = err.retryAfterSeconds ? { 'retry-after': String(err.retryAfterSeconds) } : undefined;
      throw new ApiException(429, 'rate_limited', err.message, retry);
    }
    if (err.reason === 'invalid_config') throw new ApiException(400, 'invalid_config', err.message);
    if (err.reason === 'provider_unavailable') throw new ApiException(502, err.reason, err.message);
    throw new ApiException(409, err.reason, err.message);
  }
  throw err;
}

/** Connection lifecycle over the API (WB-02): create, authorize, validate, discover, scope, delete. */
@Injectable()
export class ConnectionsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(KEY_RING) private readonly keys: KeyRing,
    @Inject(CONNECTOR_REGISTRY) private readonly registry: ConnectorRegistry,
    @Inject(CONNECTOR_RUNTIME) private readonly runtime: ConnectorRuntime,
    @Inject(QUEUES) private readonly queues: Queues,
    private readonly audit: AuditService,
    private readonly privateOps: PrivateOpsService,
  ) {}

  catalog() {
    return this.registry.list();
  }

  async create(
    ctx: TenantContext,
    input: {
      provider: string;
      displayName: string;
      executionLocation: 'cloud' | 'private';
      config: Record<string, unknown>;
    },
  ): Promise<ConnectionWithScopes> {
    if (!this.registry.has(input.provider))
      throw new ApiException(400, 'unknown_connector', 'Unknown connector');
    const connector = this.registry.get(input.provider);
    if (!connector.executionLocations.includes(input.executionLocation))
      throw new ApiException(400, 'unsupported_location', 'This connector cannot run in that location');
    const check = connector.validateConfig?.(input.config) ?? { ok: true };
    if (!check.ok)
      throw new ApiException(
        400,
        'validation_failed',
        `Invalid fields: ${(check.errors ?? ['config']).join(', ')}`,
      );
    const isPrivate = input.executionLocation === 'private';
    if (isPrivate) await this.privateOps.assertConfig(ctx, input.config);
    // Managed databases are reached over the internet: never in plaintext.
    if (!isPrivate && DB_PROVIDERS.includes(input.provider) && input.config.tls === false)
      throw new ApiException(400, 'validation_failed', 'Managed databases require TLS');

    const created = await withTenant(this.prisma, ctx, async (tx) => {
      const connection = await tx.connection.create({
        data: {
          organizationId: ctx.organizationId,
          provider: input.provider,
          displayName: input.displayName,
          executionLocation: input.executionLocation,
          // Private connections never receive credentials here: they validate straight away.
          ...(isPrivate ? { status: transition('draft', 'auth_completed') } : {}),
          config: input.config as Prisma.InputJsonValue,
          createdByUserId: ctx.actor.kind === 'user' ? ctx.actor.userId : null,
        },
        include: withScopes,
      });
      await this.audit.record(tx, ctx, {
        action: 'connection.created',
        targetType: 'connection',
        targetId: connection.id,
        metadata: {
          provider: input.provider,
          displayName: input.displayName,
          executionLocation: input.executionLocation,
          ...(input.config.allowInsecure === true ? { allowInsecure: true } : {}),
        },
      });
      return connection;
    });
    if (isPrivate) await this.privateOps.dispatch(ctx, created, 'validate');
    return created;
  }

  /** UC-07-06: an admin accepts a database user that can write; audited, then revalidated. */
  async acknowledgeWriteOverride(ctx: TenantContext, id: string): Promise<string> {
    const current = await this.get(ctx, id);
    if (!DB_PROVIDERS.includes(current.provider))
      throw new ApiException(400, 'not_database', 'Only database connections have a write override');
    if (TERMINAL.includes(current.status)) throw closed();
    const updated = await withTenant(this.prisma, ctx, async (tx) => {
      const c = await tx.connection.update({
        where: { id },
        data: { config: { ...(current.config as Record<string, unknown>), writeOverrideAcknowledged: true } },
      });
      await this.audit.record(tx, ctx, {
        action: 'connection.write_override',
        targetType: 'connection',
        targetId: id,
        metadata: { provider: current.provider },
      });
      return c;
    });
    // Revalidate where the connection runs: the private worker, or the job queue (managed).
    return current.executionLocation === 'private'
      ? this.privateOps.dispatch(ctx, updated, 'validate')
      : this.queue(ctx, 'connection-validate', id);
  }

  async runTemplate(
    ctx: TenantContext,
    id: string,
    name: string,
    params: { from: string; to: string },
  ): Promise<string> {
    const c = await this.get(ctx, id);
    if (c.executionLocation !== 'private')
      throw new ApiException(400, 'not_private', 'Templates run on a private worker');
    if (!this.privateOps.templateNames(c.provider).includes(name))
      throw new ApiException(400, 'unknown_template', `Unknown template ${name}`);
    return this.privateOps.dispatch(ctx, c, 'template', { template: name, params });
  }

  health(ctx: TenantContext, id: string) {
    return this.get(ctx, id).then(() => this.privateOps.health(ctx, id));
  }

  effectiveStatus(ctx: TenantContext, c: ConnectionWithScopes) {
    return this.privateOps.effectiveStatus(ctx, c);
  }

  /** Connections the caller may see: all, or those scoped to one of their products. */
  list(ctx: TenantContext): Promise<ConnectionWithScopes[]> {
    const ids = ctx.productIds;
    return withTenant(this.prisma, ctx, (tx) =>
      tx.connection.findMany({
        where: ids === 'all' ? {} : { scopes: { some: { productId: { in: ids } } } },
        orderBy: { createdAt: 'asc' },
        include: withScopes,
      }),
    );
  }

  get(ctx: TenantContext, id: string): Promise<ConnectionWithScopes> {
    return withTenant(this.prisma, ctx, async (tx) => {
      const c = await tx.connection.findUnique({ where: { id }, include: withScopes });
      if (!c) throw notFound();
      return c;
    });
  }

  async hasCredentials(ctx: TenantContext, id: string): Promise<boolean> {
    return withTenant(this.prisma, ctx, async (tx) =>
      Boolean(
        await tx.connectionSecret.findUnique({ where: { connectionId: id }, select: { connectionId: true } }),
      ),
    );
  }

  /** Encrypts credentials, moves the connection to pending_validation, and queues validation. */
  async authorize(ctx: TenantContext, id: string, credentials: Record<string, string>) {
    const current = await this.get(ctx, id);
    if (TERMINAL.includes(current.status)) throw closed();
    if (OAUTH_PROVIDERS.includes(current.provider))
      throw new ApiException(400, 'oauth_required', 'Connect this provider with its sign-in flow');
    if (current.executionLocation === 'private')
      throw new ApiException(
        400,
        'credentials_local',
        "Private connections read credentials from the worker's secret file (secretRef)",
      );
    const connector = this.registry.get(current.provider);
    const fields = connector.credentialFields ?? [];
    const missing = fields
      .filter((f) => f.required !== false && !credentials[f.name])
      .map((f) => `credentials.${f.name}`);
    const unknown = Object.keys(credentials)
      .filter((k) => !fields.some((f) => f.name === k))
      .map((k) => `credentials.${k}`);
    if (missing.length || unknown.length)
      throw new ApiException(
        400,
        'validation_failed',
        `Invalid fields: ${[...missing, ...unknown].join(', ')}`,
      );

    // Managed databases: a pasted connection string fills the non-secret config (host, port, database).
    let configPatch: Record<string, unknown> = {};
    if (DB_PROVIDERS.includes(current.provider)) {
      if (!credentials.connectionString && !credentials.username)
        throw new ApiException(400, 'validation_failed', 'Invalid fields: credentials.connectionString');
      if (credentials.connectionString) {
        let parsed: ParsedConnection;
        try {
          parsed = parseConnectionString(credentials.connectionString);
        } catch {
          throw new ApiException(400, 'validation_failed', 'Invalid fields: credentials.connectionString');
        }
        if (parsed.engine !== current.provider)
          throw new ApiException(
            400,
            'validation_failed',
            `This is a ${parsed.engine} connection string, not ${current.provider}`,
          );
        configPatch = {
          host: parsed.host,
          port: parsed.port,
          ...(parsed.database ? { database: parsed.database } : {}),
        };
      }
    }

    const connection = await withTenant(this.prisma, ctx, async (tx) => {
      await storeCredentials(tx, ctx, id, credentials, this.keys);
      if (Object.keys(configPatch).length)
        await tx.connection.update({
          where: { id },
          data: {
            config: {
              ...(current.config as Record<string, unknown>),
              ...configPatch,
            } as Prisma.InputJsonValue,
          },
        });
      const updated = await tx.connection.update({
        where: { id },
        data: { status: transition(current.status, 'auth_completed'), statusReason: null },
        include: withScopes,
      });
      await this.audit.record(tx, ctx, {
        action: 'connection.authorized',
        targetType: 'connection',
        targetId: id,
        metadata: { fields: fields.map((f) => f.name) },
      });
      return updated;
    });
    await this.queue(ctx, 'connection-validate', id);
    return connection;
  }

  async request(ctx: TenantContext, id: string, kind: JobKind): Promise<string> {
    const c = await this.get(ctx, id);
    if (TERMINAL.includes(c.status)) throw closed();
    if (c.executionLocation === 'private') {
      if (kind !== 'connection-validate')
        throw new ApiException(
          400,
          'unsupported_operation',
          'Private connections support validate and health',
        );
      return this.privateOps.dispatch(ctx, c, 'validate');
    }
    return this.queue(ctx, kind, id);
  }

  private queue(ctx: TenantContext, kind: JobKind, connectionId: string): Promise<string> {
    return enqueue(this.queues, kind, {
      organizationId: ctx.organizationId,
      connectionId,
      requestId: ctx.requestId,
    });
  }

  /**
   * Stores what an OAuth callback returned (M13b): the refresh token (kept when the provider sends
   * none on a repeat grant), the granted scopes, and the granting account; then validates.
   */
  async completeOAuth(
    ctx: TenantContext,
    id: string,
    grant: { refreshToken?: string; grantedScopes: string[]; accountEmail: string | null },
  ) {
    const current = await this.get(ctx, id);
    if (TERMINAL.includes(current.status)) throw closed();
    if (!grant.refreshToken && !(await this.hasCredentials(ctx, id)))
      throw new ApiException(
        502,
        'oauth_no_refresh_token',
        'Google did not return offline access; remove the app in your Google account and connect again',
      );
    await withTenant(this.prisma, ctx, async (tx) => {
      if (grant.refreshToken)
        await storeCredentials(tx, ctx, id, { refreshToken: grant.refreshToken }, this.keys);
      await tx.connection.update({
        where: { id },
        data: {
          status: transition(current.status, 'auth_completed'),
          statusReason: null,
          grantedScopes: grant.grantedScopes,
          accountEmail: grant.accountEmail,
        },
      });
      await this.audit.record(tx, ctx, {
        action: 'connection.authorized',
        targetType: 'connection',
        targetId: id,
        metadata: { grantedScopes: grant.grantedScopes, accountEmail: grant.accountEmail },
      });
    });
    await this.queue(ctx, 'connection-validate', id);
  }

  /** Runs discovery now and returns the provider's resources for scoping. */
  async resources(ctx: TenantContext, id: string) {
    const c = await this.get(ctx, id);
    if (TERMINAL.includes(c.status)) throw closed();
    const page = await this.runtime.discover(ctx, id).catch(connectorFailure);
    return page.observations.map((o) => ({
      externalId: o.externalId,
      resourceType: o.resourceType,
      name: typeof o.attributes.name === 'string' ? o.attributes.name : o.externalId,
    }));
  }

  /** Replaces the connection's resource scopes; products and environments must belong to the caller. */
  async setScopes(ctx: TenantContext, id: string, scopes: ScopeInput[]) {
    const allowed = ctx.productIds;
    if (allowed !== 'all' && scopes.some((s) => !allowed.includes(s.productId))) throw notFound();
    return withTenant(this.prisma, ctx, async (tx) => {
      const c = await tx.connection.findUnique({ where: { id }, select: { status: true } });
      if (!c) throw notFound();
      if (TERMINAL.includes(c.status)) throw closed();
      const productIds = [...new Set(scopes.map((s) => s.productId))];
      const products = await tx.product.count({ where: { id: { in: productIds } } });
      if (products !== productIds.length)
        throw new ApiException(400, 'validation_failed', 'Invalid fields: productId');
      for (const s of scopes.filter((s) => s.environmentId)) {
        const env = await tx.environment.findFirst({
          where: { id: s.environmentId, productId: s.productId },
        });
        if (!env) throw new ApiException(400, 'validation_failed', 'Invalid fields: environmentId');
      }
      // Product-scoped callers replace only the scopes on their own products.
      await tx.connectionResourceScope.deleteMany({
        where: allowed === 'all' ? { connectionId: id } : { connectionId: id, productId: { in: allowed } },
      });
      await tx.connectionResourceScope.createMany({
        data: scopes.map((s) => ({ organizationId: ctx.organizationId, connectionId: id, ...s })),
        skipDuplicates: true,
      });
      await this.audit.record(tx, ctx, {
        action: 'connection.scopes_updated',
        targetType: 'connection',
        targetId: id,
        metadata: { count: scopes.length, productIds },
      });
      return tx.connectionResourceScope.findMany({
        where: allowed === 'all' ? { connectionId: id } : { connectionId: id, productId: { in: allowed } },
        orderBy: { createdAt: 'asc' },
      });
    });
  }

  syncRuns(ctx: TenantContext, id: string) {
    return withTenant(this.prisma, ctx, (tx) =>
      tx.syncRun.findMany({ where: { connectionId: id }, orderBy: { createdAt: 'desc' }, take: 50 }),
    );
  }

  webhookDeliveries(ctx: TenantContext, id: string) {
    return withTenant(this.prisma, ctx, (tx) =>
      tx.webhookDelivery.findMany({ where: { connectionId: id }, orderBy: { receivedAt: 'desc' }, take: 50 }),
    );
  }

  changeEvents(ctx: TenantContext, id: string) {
    return withTenant(this.prisma, ctx, (tx) =>
      tx.changeEvent.findMany({ where: { connectionId: id }, orderBy: { occurredAt: 'desc' }, take: 50 }),
    );
  }

  /** What the last discovery stored, for scoping without calling the provider again. */
  inventory(ctx: TenantContext, id: string) {
    return withTenant(this.prisma, ctx, (tx) =>
      tx.connectionInventoryItem.findMany({
        where: { connectionId: id },
        orderBy: [{ resourceType: 'asc' }, { name: 'asc' }],
        take: 5000,
      }),
    );
  }

  /** Crypto-shreds the credentials and marks the connection disconnected (terminal). */
  async remove(ctx: TenantContext, id: string): Promise<ConnectionStatus> {
    return withTenant(this.prisma, ctx, async (tx) => {
      const c = await tx.connection.findUnique({ where: { id }, select: { status: true } });
      if (!c) throw notFound();
      await tx.connectionSecret.deleteMany({ where: { connectionId: id } });
      // Scheduled health checks and syncs stop with the connection.
      await tx.jobDefinition.updateMany({ where: { entityId: id }, data: { enabled: false } });
      if (TERMINAL.includes(c.status)) return c.status;
      await tx.connection.update({
        where: { id },
        data: { status: transition(c.status, 'disconnected'), statusReason: null },
      });
      await this.audit.record(tx, ctx, {
        action: 'connection.deleted',
        targetType: 'connection',
        targetId: id,
      });
      return 'disconnected' as const;
    });
  }
}
