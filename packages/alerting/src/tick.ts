import type { Prisma } from '@pcp/database';
import { escalate, ingest, type NormalizedAlert, type NotifyRequest } from './engine.js';

type Tx = Prisma.TransactionClient;

/**
 * The worker's per-tenant minute (WB-13 UC-13-03/07): evaluates the rules that are not metric
 * rules (agent heartbeat missing, integration failing), feeds the incident engine with firing
 * and resolved alerts, then escalates. Runs inside the tenant transaction.
 */
export async function tick(tx: Tx, organizationId: string, now: Date): Promise<NotifyRequest[]> {
  const rules = await tx.alertRule.findMany({
    where: { enabled: true, archivedAt: null, template: { in: ['agent_heartbeat_missing', 'connection_degraded'] } },
  });
  const alerts: NormalizedAlert[] = [];
  for (const rule of rules) {
    const minutes = Number((rule.params as Record<string, unknown>).minutes ?? 5);
    const cutoff = now.getTime() - minutes * 60_000;
    if (rule.template === 'agent_heartbeat_missing') {
      const agents = await tx.agent.findMany({
        where: { agentType: 'host', ...(rule.productId ? { productId: rule.productId } : {}) },
        select: { id: true, hostname: true, status: true, lastHeartbeatAt: true, createdAt: true },
      });
      for (const a of agents) {
        // Revoked agents are not expected to report: never fire, and close what is open (Review Focus #5).
        const silent = a.status === 'active' && (a.lastHeartbeatAt ?? a.createdAt).getTime() < cutoff;
        alerts.push({
          ruleId: rule.id,
          labels: { agent_id: a.id, hostname: a.hostname },
          status: silent ? 'firing' : 'resolved',
          startsAt: now,
          ...(silent ? {} : { endsAt: now }),
        });
      }
    } else {
      const connections = await tx.connection.findMany({
        where: rule.productId ? { scopes: { some: { productId: rule.productId } } } : {},
        select: { id: true, displayName: true, status: true, updatedAt: true },
      });
      for (const c of connections) {
        const failing = c.status === 'degraded' && c.updatedAt.getTime() < cutoff;
        alerts.push({
          ruleId: rule.id,
          labels: { connection_id: c.id, connection_name: c.displayName },
          status: failing ? 'firing' : 'resolved',
          startsAt: now,
          ...(failing ? {} : { endsAt: now }),
        });
      }
    }
  }
  const result = await ingest(tx, organizationId, alerts, now);
  return [...result.notify, ...(await escalate(tx, now))];
}
