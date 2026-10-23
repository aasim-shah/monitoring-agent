import type { Prisma } from '@pcp/database';
import type { NotifyRequest } from './engine.js';

type Tx = Prisma.TransactionClient;

/**
 * One pending delivery per active channel for each notify request (UC-13-05). Escalations go to
 * the channels marked for escalation, or to every channel when none is marked (UC-13-07).
 * Broken channels are skipped. Returns the delivery IDs to queue after the transaction commits.
 */
export async function createDeliveries(
  tx: Tx,
  organizationId: string,
  requests: NotifyRequest[],
): Promise<string[]> {
  if (requests.length === 0) return [];
  const channels = await tx.notificationChannel.findMany({
    where: { status: 'active' },
    select: { id: true, escalation: true },
  });
  const escalationChannels = channels.some((c) => c.escalation)
    ? channels.filter((c) => c.escalation)
    : channels;
  const ids: string[] = [];
  for (const r of requests) {
    for (const c of r.event === 'escalated' ? escalationChannels : channels) {
      const d = await tx.notificationDelivery.create({
        data: { organizationId, channelId: c.id, incidentId: r.incidentId, event: r.event },
        select: { id: true },
      });
      ids.push(d.id);
    }
  }
  return ids;
}
