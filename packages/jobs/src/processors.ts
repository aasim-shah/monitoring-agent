import { Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { NotFoundError, type ConnectorRuntime } from '@pcp/connector-runtime';
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

const SYNC_KIND: Record<'connection-validate' | 'connection-discover', 'validate' | 'discover'> = {
  'connection-validate': 'validate',
  'connection-discover': 'discover',
};

/** BullMQ workers for connection jobs; each run is recorded in sync_runs, outcomes in job_executions. */
export function startProcessors(deps: ProcessorDeps): Processors {
  const now = deps.now ?? (() => new Date());
  const connection = new Redis(deps.redisUrl, { maxRetriesPerRequest: null });

  const process = (kind: JobKind) => async (job: Job<ConnectionJobPayload>) => {
    const { organizationId, connectionId } = job.data;
    const ctx = systemContext(organizationId, job);
    if (kind !== 'connection-validate' && kind !== 'connection-discover' && kind !== 'connection-health') {
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
      if (kind === 'connection-validate') await deps.runtime.validate(ctx, connectionId);
      else {
        const { observations } = await deps.runtime.discover(ctx, connectionId);
        items = observations.length;
        await storeInventory(deps.prisma, ctx, connectionId, observations, now());
      }
      await withTenant(deps.prisma, ctx, (tx) =>
        tx.syncRun.update({ where: { id: run.id }, data: { status: 'succeeded', finishedAt: now(), items } }),
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
