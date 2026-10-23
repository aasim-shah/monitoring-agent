import type { ChatProvider } from '@pcp/ai-orchestrator';
import { Prisma, type PrismaClient } from '@pcp/database';
import { enqueue, type Queues } from '@pcp/jobs';
import { sendToChannel, type DeliveryDeps } from '@pcp/notifications';
import {
  buildSnapshot,
  localDayWindow,
  narrate,
  nextRunAt,
  renderReport,
  type NarrativeStatus,
  type ReportSources,
  type Snapshot,
} from '@pcp/reports';
import type { TenantContext } from '@pcp/shared-contracts';
import { withTenant } from '@pcp/tenant-security';

/** A run that starts more than this after its scheduled time is marked late (WB-15 §9). */
const LATE_AFTER_MS = 15 * 60_000;

export interface ReportDeps {
  prisma: PrismaClient;
  queues: Queues;
  now(): Date;
  /** Null when no AI provider is configured: the report goes out without a narrative. */
  provider: ChatProvider | null;
  appOrigin: string;
  sources(ctx: TenantContext, productId: string): ReportSources;
  delivery: DeliveryDeps;
}

/** Only what the handlers read from a BullMQ job. */
interface JobLike {
  data: { window?: string };
  attemptsMade: number;
  opts: { attempts?: number };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const dateOnly = (localDate: string) => new Date(`${localDate}T00:00:00Z`);

/** Job handlers for the M15 kinds (WB-15 UC-15-02/03/08/09). */
export function reportHandlers(deps: ReportDeps) {
  return {
    /**
     * One report version for one local date. The scheduled run is version 1 (window
     * `YYYY-MM-DD`); "Run now" and "Regenerate" pass `YYYY-MM-DD__v<n>`. A retry finds the
     * existing row and only re-queues its unsent deliveries (BR-15-04).
     */
    'report-generate': async (ctx: TenantContext, scheduleId: string, job: JobLike) => {
      const [localDate = '', v] = (job.data.window ?? '').split('__v');
      if (!DATE.test(localDate)) return { skipped: 'invalid window' };
      const version = v ? Number(v) : 1;
      const schedule = await withTenant(deps.prisma, ctx, async (tx) => {
        const s = await tx.reportSchedule.findUnique({ where: { id: scheduleId } });
        if (!s) return null;
        // The schedule runs with its creator's reach: no product access, no report (M15.1).
        if (s.createdByUserId) {
          const m = await tx.organizationMember.findUnique({
            where: { organizationId_userId: { organizationId: s.organizationId, userId: s.createdByUserId } },
          });
          if (!m || (!m.allProducts && !m.productIds.includes(s.productId))) return 'no_access' as const;
        }
        return s;
      });
      if (!schedule) return { skipped: 'schedule not found' };
      if (schedule === 'no_access') return { failed: 'not_found' };

      const key = { scheduleId_localDate_version: { scheduleId, localDate: dateOnly(localDate), version } };
      let report = await withTenant(deps.prisma, ctx, (tx) => tx.generatedReport.findUnique({ where: key }));
      if (!report) {
        const w = localDayWindow(schedule.timezone, localDate);
        const snapshot = await buildSnapshot(deps.sources(ctx, schedule.productId), w);
        const ai = await withTenant(deps.prisma, ctx, (tx) =>
          tx.aiSettings.findUnique({ where: { organizationId: ctx.organizationId } }),
        );
        const narrative = await narrate(snapshot, deps.provider, { disabled: ai?.disabled ?? false });
        const scheduledAt = nextRunAt(schedule.timezone, schedule.localTime, new Date(w.end.getTime() - 1));
        const late = !v && deps.now().getTime() - scheduledAt.getTime() > LATE_AFTER_MS;
        try {
          report = await withTenant(deps.prisma, ctx, async (tx) => {
            const channels = await tx.notificationChannel.findMany({
              where: { id: { in: schedule.channelIds } },
              select: { id: true, kind: true },
            });
            return tx.generatedReport.create({
              data: {
                organizationId: ctx.organizationId,
                productId: schedule.productId,
                scheduleId,
                localDate: dateOnly(localDate),
                version,
                windowStart: w.start,
                windowEnd: w.end,
                timezone: w.timezone,
                snapshot: snapshot as unknown as Prisma.InputJsonValue,
                narrative: narrative.text,
                narrativeStatus: narrative.status,
                problems: narrative.problems,
                late,
                deliveries: {
                  create: [
                    ...channels.map((c) => ({
                      organizationId: ctx.organizationId,
                      channelId: c.id,
                      kind: c.kind,
                      target: `channel:${c.id}`,
                    })),
                    ...schedule.recipients.map((email) => ({
                      organizationId: ctx.organizationId,
                      kind: 'email' as const,
                      target: email,
                    })),
                  ],
                },
              },
            });
          });
        } catch (err) {
          // Another run for the same schedule, date, and version won the race: use its row.
          if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
          report = await withTenant(deps.prisma, ctx, (tx) =>
            tx.generatedReport.findUniqueOrThrow({ where: key }),
          );
        }
      }
      const pending = await withTenant(deps.prisma, ctx, (tx) =>
        tx.reportDelivery.findMany({
          where: { reportId: report.id, status: { in: ['pending', 'failed'] } },
          select: { id: true },
        }),
      );
      for (const d of pending)
        await enqueue(deps.queues, 'report-deliver', {
          organizationId: ctx.organizationId,
          connectionId: d.id,
          requestId: `report-delivery-${d.id}`,
        });
      return { reportId: report.id, version: report.version, deliveries: pending.length };
    },

    /** One delivery of one report version; the last of the 5 attempts dead-letters it. */
    'report-deliver': async (ctx: TenantContext, deliveryId: string, job: JobLike) => {
      const final = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      const loaded = await withTenant(deps.prisma, ctx, async (tx) => {
        const d = await tx.reportDelivery.findUnique({
          where: { id: deliveryId },
          include: { report: { include: { product: { select: { name: true } } } } },
        });
        if (!d || d.status === 'sent' || d.status === 'dead') return null;
        const channel = d.channelId
          ? await tx.notificationChannel.findUnique({ where: { id: d.channelId } })
          : null;
        return { d, channel };
      });
      if (!loaded) return { skipped: 'delivery gone or already final' };
      const { d, channel } = loaded;
      const r = d.report;
      const link = `${deps.appOrigin}/orgs/${ctx.organizationId}/products/${r.productId}/reports/${r.id}`;
      const message = renderReport(
        {
          snapshot: r.snapshot as unknown as Snapshot,
          narrative: r.narrative,
          narrativeStatus: r.narrativeStatus as NarrativeStatus,
          productName: r.product.name,
          late: r.late,
        },
        link,
      );
      const record = (data: Prisma.ReportDeliveryUpdateInput) =>
        withTenant(deps.prisma, ctx, (tx) => tx.reportDelivery.update({ where: { id: deliveryId }, data }));
      // A deleted channel cannot succeed on a retry: dead at once.
      const gone = d.channelId !== null && !channel;
      try {
        if (gone) throw new Error('the notification channel was deleted');
        if (channel) await sendToChannel(channel, message, deps.delivery);
        else
          await deps.delivery.sendMail({
            to: [d.target],
            subject: message.subject,
            text: message.text,
            html: message.html,
          });
      } catch (err) {
        await record({
          status: final || gone ? 'dead' : 'failed',
          attempts: { increment: 1 },
          lastError: (err instanceof Error ? err.message : String(err)).slice(0, 500),
        });
        throw err;
      }
      await record({ status: 'sent', attempts: { increment: 1 }, sentAt: deps.now(), lastError: null });
      return { sent: true };
    },
  };
}
