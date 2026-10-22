import type { PrismaClient } from '@pcp/database';
import { JOB_KINDS, type JobKind, type Queues } from './queues.js';

interface Definition {
  organization_id: string;
  id: string;
  kind: string;
  entity_id: string;
  every_seconds: number;
}

const PREFIX = 'schedule-';

/**
 * Makes BullMQ's job schedulers match the enabled job_definitions (PostgreSQL is the
 * source of truth; Redis only coordinates). Run at startup and periodically.
 * `scheduler` connects as pcp_scheduler and reads definitions through pcp_due_job_definitions().
 */
export async function reconcileSchedules(
  scheduler: PrismaClient,
  queues: Queues,
): Promise<{ upserted: number; removed: number }> {
  const defs = await scheduler.$queryRaw<Definition[]>`SELECT * FROM pcp_due_job_definitions()`;
  let upserted = 0;
  let removed = 0;
  for (const kind of JOB_KINDS) {
    const queue = queues.get(kind);
    const wanted = defs.filter((d) => d.kind === kind);
    const wantedIds = new Set(wanted.map((d) => `${PREFIX}${d.id}`));
    for (const s of await queue.getJobSchedulers()) {
      if (s.key.startsWith(PREFIX) && !wantedIds.has(s.key)) {
        await queue.removeJobScheduler(s.key);
        removed += 1;
      }
    }
    for (const d of wanted) {
      await queue.upsertJobScheduler(
        `${PREFIX}${d.id}`,
        { every: d.every_seconds * 1000 },
        {
          name: kind as JobKind,
          data: {
            organizationId: d.organization_id,
            connectionId: d.entity_id,
            requestId: `${PREFIX}${d.id}`,
          },
          opts: queues.jobOptions(),
        },
      );
      upserted += 1;
    }
  }
  return { upserted, removed };
}
