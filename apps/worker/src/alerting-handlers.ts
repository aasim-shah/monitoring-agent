import { createDeliveries, tick } from '@pcp/alerting';
import type { PrismaClient } from '@pcp/database';
import { enqueue, type Queues } from '@pcp/jobs';
import { processDelivery, type DeliveryDeps } from '@pcp/notifications';
import type { TenantContext } from '@pcp/shared-contracts';
import { withTenant } from '@pcp/tenant-security';

export interface AlertingDeps extends DeliveryDeps {
  prisma: PrismaClient;
  queues: Queues;
}

/** Only what the handlers read from a BullMQ job. */
interface JobLike {
  attemptsMade: number;
  opts: { attempts?: number };
}

/** Job handlers for the M12 kinds (WB-13 UC-13-03/05/07). */
export function alertingHandlers(deps: AlertingDeps) {
  return {
    /** Per-tenant minute: worker-evaluated rules, escalation, then queued deliveries. */
    'alert-tick': async (ctx: TenantContext, _organizationId: string, _job: JobLike) => {
      const org = ctx.organizationId;
      const ids = await withTenant(deps.prisma, ctx, async (tx) =>
        createDeliveries(tx, org, await tick(tx, org, deps.now())),
      );
      for (const id of ids)
        await enqueue(deps.queues, 'notification-deliver', {
          organizationId: org,
          connectionId: id,
          requestId: `delivery-${id}`,
        });
      return { deliveries: ids.length };
    },
    /** One delivery; the last of the 5 attempts dead-letters it. */
    'notification-deliver': (ctx: TenantContext, deliveryId: string, job: JobLike) =>
      processDelivery(deps.prisma, ctx, deliveryId, job.attemptsMade + 1 >= (job.opts.attempts ?? 1), deps),
  };
}
