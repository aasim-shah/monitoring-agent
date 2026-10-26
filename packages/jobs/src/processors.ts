import { Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { NotFoundError, type ConnectorRuntime } from '@pcp/connector-runtime';
import type { MetricPoint } from '@pcp/connector-sdk';
import type { Prisma, PrismaClient } from '@pcp/database';
import type { Observation, TenantContext } from '@pcp/shared-contracts';
import { withTenant } from '@pcp/tenant-security';
import { JOB_KINDS, type ConnectionJobPayload, type JobKind } from './queues.js';

export interface ProcessorDeps {
  redisUrl: string;
  prisma: PrismaClient;
  runtime: ConnectorRuntime;
  concurrency?: number;
  now?: () => Date;
  /** Which queues to consume; all kinds by default (the worker). */
  kinds?: readonly JobKind[];
  /** Called once when a sync finds the grant revoked (WB-08 UC-08-10): tell the owner. */
  onReauthorizationRequired?: (ctx: TenantContext, connectionId: string) => Promise<void>;
  /** Handlers for kinds that are not connection jobs (alert-tick, notification-deliver). */
  handlers?: Partial<Record<JobKind, (ctx: TenantContext, entityId: string, job: Job) => Promise<unknown>>>;
}

export interface Processors {
  close(): Promise<void>;
}

const systemContext = (organizationId: string, job: Job): TenantContext => ({
  organizationId,
  actor: { kind: 'system', jobId: String(job.id) },
  roles: ['owner'],
  productIds: 'all',
  environmentIds: 'all',
  requestId: job.data.requestId,
});

/** At most this many discovered resources are kept per connection. */
const MAX_INVENTORY = 5000;

/**
 * Replaces a connection's inventory with what discovery just found (WB-06): zones, repositories,
 * targets, dashboards. Asset discovery reads it for the products the resources are scoped to.
 */
async function storeInventory(
  prisma: PrismaClient,
  ctx: TenantContext,
  connectionId: string,
  observations: Observation[],
  observedAt: Date,
) {
  const rows = new Map<string, Observation>();
  for (const o of observations.slice(0, MAX_INVENTORY))
    rows.set(`${o.resourceType}:${o.externalId ?? ''}`, o);
  await withTenant(prisma, ctx, async (tx) => {
    await tx.connectionInventoryItem.deleteMany({ where: { connectionId } });
    if (!rows.size) return;
    await tx.connectionInventoryItem.createMany({
      data: [...rows.values()].map((o) => ({
        organizationId: ctx.organizationId,
        connectionId,
        resourceType: o.resourceType,
        externalId: o.externalId ?? o.resourceType,
        name: String(o.attributes.name ?? o.externalId ?? o.resourceType).slice(0, 256),
        attributes: o.attributes as Prisma.InputJsonValue,
        observedAt,
      })),
    });
  });
}

/** Days read on a connection's first sync, then on every later one (late provider corrections). */
const FIRST_SYNC_DAYS = 28;
const SYNC_DAYS = 3;

/** Upserts daily values; a null value is never stored (no zero for missing data, BR-09-05). */
async function storeMetrics(
  prisma: PrismaClient,
  ctx: TenantContext,
  connectionId: string,
  points: MetricPoint[],
  fetchedAt: Date,
): Promise<number> {
  const rows = points
    .filter((p) => p.value !== null && Number.isFinite(p.value))
    .map((p) => ({
      resource_type: p.resourceType,
      external_id: p.externalId,
      metric: p.metric,
      dimension: p.dimension ?? '',
      day: p.day,
      value: p.value,
      completeness: p.completeness,
    }));
  if (!rows.length) return 0;
  await withTenant(prisma, ctx, async (tx) => {
    // A revised billing day may drop a service (for example after a credit).
    // Replace its breakdown atomically so stale groups cannot outlive the new total.
    const costDays = rows.filter(
      (r) => r.resource_type === 'aws_cost_account' && r.metric === 'cost_usd' && r.dimension === '',
    );
    if (costDays.length)
      await tx.metricAggregate.deleteMany({
        where: {
          connectionId,
          resourceType: 'aws_cost_account',
          metric: 'cost_usd',
          dimension: { not: '' },
          OR: costDays.map((r) => ({ externalId: r.external_id, day: new Date(`${r.day}T00:00:00Z`) })),
        },
      });
    return tx.$executeRaw`
      INSERT INTO metric_aggregates
        (organization_id, connection_id, resource_type, external_id, metric, dimension, day, value, completeness, fetched_at)
      SELECT ${ctx.organizationId}::uuid, ${connectionId}::uuid, r.resource_type, r.external_id, r.metric,
             r.dimension, r.day::date, r.value, r.completeness, ${fetchedAt}
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
        AS r(resource_type text, external_id text, metric text, dimension text, day text, value float8, completeness text)
      ON CONFLICT (connection_id, resource_type, external_id, metric, dimension, day)
      DO UPDATE SET value = EXCLUDED.value, completeness = EXCLUDED.completeness, fetched_at = EXCLUDED.fetched_at`;
  });
  return rows.length;
}

type RunKind = 'connection-validate' | 'connection-discover' | 'connection-sync';
const SYNC_KIND: Record<RunKind, 'validate' | 'discover' | 'sync'> = {
  'connection-validate': 'validate',
  'connection-discover': 'discover',
  'connection-sync': 'sync',
};

/** BullMQ workers for connection jobs; each run is recorded in sync_runs, outcomes in job_executions. */
export function startProcessors(deps: ProcessorDeps): Processors {
  const now = deps.now ?? (() => new Date());
  const connection = new Redis(deps.redisUrl, { maxRetriesPerRequest: null });

  const process = (kind: JobKind) => async (job: Job<ConnectionJobPayload>) => {
    const { organizationId, connectionId } = job.data;
    const ctx = systemContext(organizationId, job);
    if (
      kind !== 'connection-validate' &&
      kind !== 'connection-discover' &&
      kind !== 'connection-sync' &&
      kind !== 'connection-health'
    ) {
      const handler = deps.handlers?.[kind];
      return handler ? handler(ctx, connectionId, job) : { skipped: 'no handler' };
    }
    // Health checks are recorded in connection_health by the runtime, not as sync runs.
    if (kind === 'connection-health') {
      try {
        return await deps.runtime.health(ctx, connectionId);
      } catch (err) {
        if (err instanceof NotFoundError) return { skipped: 'connection not found' };
        throw err;
      }
    }
    const run = await withTenant(deps.prisma, ctx, async (tx) => {
      const exists = await tx.connection.findUnique({
        where: { id: connectionId },
        select: { status: true },
      });
      if (!exists || exists.status === 'disconnected' || exists.status === 'revoked') return null;
      return tx.syncRun.create({
        data: {
          organizationId,
          connectionId,
          kind: SYNC_KIND[kind],
          status: 'running',
          jobId: String(job.id),
          startedAt: now(),
        },
      });
    });
    if (!run) return { skipped: 'connection deleted or disconnected' };

    try {
      let items: number | null = null;
      let syncGaps: string[] = [];
      if (kind === 'connection-validate') await deps.runtime.validate(ctx, connectionId);
      else if (kind === 'connection-sync') {
        const seen = await withTenant(deps.prisma, ctx, (tx) =>
          tx.metricAggregate.count({ where: { connectionId } }),
        );
        const { points, gaps } = await deps.runtime.sync(ctx, connectionId, {
          days: seen ? SYNC_DAYS : FIRST_SYNC_DAYS,
        });
        syncGaps = gaps;
        items = await storeMetrics(deps.prisma, ctx, connectionId, points, now());
      } else {
        const { observations } = await deps.runtime.discover(ctx, connectionId);
        items = observations.length;
        await storeInventory(deps.prisma, ctx, connectionId, observations, now());
      }
      await withTenant(deps.prisma, ctx, (tx) =>
        tx.syncRun.update({
          where: { id: run.id },
          data: {
            status: 'succeeded',
            finishedAt: now(),
            items,
            errorMessage: syncGaps.length ? syncGaps.join('; ').slice(0, 4000) : null,
          },
        }),
      );
      return { items };
    } catch (err) {
      if (err instanceof NotFoundError) {
        await withTenant(deps.prisma, ctx, (tx) =>
          tx.syncRun.updateMany({ where: { id: run.id }, data: { status: 'cancelled', finishedAt: now() } }),
        );
        return { skipped: 'connection not found' };
      }
      const e = err as Error & { reason?: string };
      // A revoked grant stops syncing until someone reconnects: no retries, the owner is told once.
      const revoked = kind === 'connection-sync' && e.reason === 'reauthorization_required';
      await withTenant(deps.prisma, ctx, (tx) =>
        tx.syncRun.updateMany({
          where: { id: run.id },
          data: {
            status: 'failed',
            finishedAt: now(),
            errorCode: e.reason ?? 'error',
            errorMessage: e.message,
          },
        }),
      );
      if (revoked) {
        if (await deps.runtime.markReauthorizationRequired(ctx, connectionId))
          await deps.onReauthorizationRequired?.(ctx, connectionId);
        return { skipped: 'reauthorization_required' };
      }
      throw err;
    }
  };

  const record = async (
    job: Job<ConnectionJobPayload>,
    status: 'succeeded' | 'dead_letter',
    error?: string,
  ) => {
    const ctx = systemContext(job.data.organizationId, job);
    await withTenant(deps.prisma, ctx, (tx) =>
      tx.jobExecution.create({
        data: {
          organizationId: job.data.organizationId,
          jobId: String(job.id),
          kind: job.name,
          status,
          attempts: job.attemptsMade,
          error: error ?? null,
          finishedAt: now(),
        },
      }),
    );
  };

  const workers = (deps.kinds ?? JOB_KINDS).map((kind) => {
    const worker = new Worker<ConnectionJobPayload>(kind, process(kind), {
      connection,
      concurrency: deps.concurrency ?? 5,
    });
    worker.on('completed', (job) => void record(job, 'succeeded').catch(() => {}));
    worker.on('failed', (job, err) => {
      if (job && job.attemptsMade >= (job.opts.attempts ?? 1))
        void record(job, 'dead_letter', err.message).catch(() => {});
    });
    return worker;
  });

  return {
    async close() {
      await Promise.all(workers.map((w) => w.close()));
      connection.disconnect();
    },
  };
}
