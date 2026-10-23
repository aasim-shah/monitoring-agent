import { Queue, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { jobId } from './job-id.js';

export const JOB_KINDS = [
  'connection-validate',
  'connection-discover',
  'connection-health',
  // M12: per-organization alert tick (entity = organization) and one notification delivery (entity = delivery).
  'alert-tick',
  'notification-deliver',
  // M13a: one website probe (entity = monitor).
  'website-probe',
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

/**
 * Only identifiers: workers rebuild tenant context from these server-set values. Never secrets.
 * `connectionId` is the job's entity: a connection, or for M12 kinds an organization or delivery.
 */
export interface ConnectionJobPayload {
  organizationId: string;
  connectionId: string;
  requestId: string;
}

export interface Queues {
  get(kind: JobKind): Queue<ConnectionJobPayload>;
  all(): Queue<ConnectionJobPayload>[];
  jobOptions(): JobsOptions;
  schedulerIds(): Promise<string[]>;
  close(): Promise<void>;
}

/** Master plan §3: 5 attempts, exponential backoff from 10 s, then dead letter. */
export function createQueues(redisUrl: string, opts: { backoffMs?: number } = {}): Queues {
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const queues = new Map(JOB_KINDS.map((k) => [k, new Queue<ConnectionJobPayload>(k, { connection })]));
  const jobOptions: JobsOptions = {
    attempts: 5,
    backoff: { type: 'exponential', delay: opts.backoffMs ?? 10_000 },
    // Removed on completion, so the same ID can run again later; while queued it deduplicates.
    removeOnComplete: true,
    removeOnFail: { age: 24 * 3600 },
  };
  return {
    get: (kind) => queues.get(kind)!,
    all: () => [...queues.values()],
    jobOptions: () => jobOptions,
    async schedulerIds() {
      const lists = await Promise.all([...queues.values()].map((q) => q.getJobSchedulers()));
      return lists.flat().map((s) => s.key);
    },
    async close() {
      await Promise.all([...queues.values()].map((q) => q.close()));
      connection.disconnect();
    },
  };
}

export async function enqueue(
  queues: Queues,
  kind: JobKind,
  payload: ConnectionJobPayload,
  window?: string,
): Promise<string> {
  const id = jobId(kind, payload.organizationId, payload.connectionId, window);
  await queues.get(kind).add(kind, payload, { ...queues.jobOptions(), jobId: id });
  return id;
}
