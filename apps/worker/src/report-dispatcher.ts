import type { PrismaClient } from '@pcp/database';
import { enqueue, type Queues } from '@pcp/jobs';
import { nextRunAt, reportWindow } from '@pcp/reports';
import { withTenant } from '@pcp/tenant-security';

const system = (organizationId: string) => ({
  organizationId,
  actor: { kind: 'system' as const, jobId: 'report-dispatcher' },
  roles: ['owner' as const],
  productIds: 'all' as const,
  environmentIds: 'all' as const,
  requestId: 'report-dispatcher',
});

/**
 * Due daily reports (spec §13.3 A): reads due schedules as pcp_scheduler (BR-15-07), queues
 * `report-generate` for the prior local day of the scheduled instant, then moves the schedule on
 * with a compare-and-set. Queuing first means a crash re-queues the same job ID, never skips a
 * day; a missed day (worker down) is caught up one run at a time.
 */
export async function dispatchDueReports(deps: {
  scheduler: PrismaClient;
  prisma: PrismaClient;
  queues: Queues;
  now: () => Date;
}): Promise<number> {
  const due = await deps.scheduler.$queryRaw<
    Array<{ organization_id: string; id: string; next_run_at: Date }>
  >`
    SELECT organization_id, id, next_run_at FROM pcp_due_report_schedules(${deps.now()})`;
  let queued = 0;
  for (const d of due) {
    const s = await withTenant(deps.prisma, system(d.organization_id), (tx) =>
      tx.reportSchedule.findUnique({ where: { id: d.id }, select: { timezone: true, localTime: true } }),
    );
    if (!s) continue;
    const w = reportWindow(s.timezone, d.next_run_at);
    await enqueue(
      deps.queues,
      'report-generate',
      { organizationId: d.organization_id, connectionId: d.id, requestId: `report-${d.id}-${w.localDate}` },
      w.localDate,
    );
    const next = nextRunAt(s.timezone, s.localTime, d.next_run_at);
    const [moved] = await deps.scheduler.$queryRaw<Array<{ ok: boolean }>>`
      SELECT pcp_advance_report_schedule(${d.id}::uuid, ${d.next_run_at}, ${next}) AS ok`;
    if (moved?.ok) queued++;
  }
  return queued;
}
