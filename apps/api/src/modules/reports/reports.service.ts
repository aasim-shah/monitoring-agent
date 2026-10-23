import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import type { GeneratedReport, PrismaClient, ReportSchedule } from '@pcp/database';
import { enqueue, type Queues } from '@pcp/jobs';
import { isValidLocalTime, isValidTimezone, nextRunAt, reportWindow } from '@pcp/reports';
import type { TenantContext } from '@pcp/shared-contracts';
import { withTenant } from '@pcp/tenant-security';
import { ApiException, notFound } from '../../common/errors.js';
import { CLOCK, PRISMA } from '../../tokens.js';
import { AuditService } from '../auditing/audit.service.js';

export const REPORT_QUEUES = Symbol('REPORT_QUEUES');
export const MAX_RECIPIENTS = 10;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ScheduleInput {
  name: string;
  timezone: string;
  localTime: string;
  channelIds: string[];
  recipients: string[];
  environmentId?: string | null;
  enabled?: boolean;
}

const scheduleView = (s: ReportSchedule) => ({
  id: s.id,
  productId: s.productId,
  environmentId: s.environmentId,
  name: s.name,
  template: s.template,
  timezone: s.timezone,
  localTime: s.localTime,
  channelIds: s.channelIds,
  recipients: s.recipients,
  enabled: s.enabled,
  nextRunAt: s.nextRunAt,
  createdAt: s.createdAt,
});

const day = (d: Date) => d.toISOString().slice(0, 10);

const reportSummary = (r: GeneratedReport & { schedule: { name: string } | null }) => ({
  id: r.id,
  productId: r.productId,
  scheduleId: r.scheduleId,
  scheduleName: r.schedule?.name ?? null,
  localDate: day(r.localDate),
  version: r.version,
  narrativeStatus: r.narrativeStatus,
  late: r.late,
  createdAt: r.createdAt,
});

/** Daily report schedules and history (WB-15 UC-15-01/04/09); generation runs in the worker. */
@Injectable()
export class ReportsService implements OnApplicationShutdown {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(CLOCK) private readonly now: () => Date,
    @Inject(REPORT_QUEUES) private readonly queues: Queues,
    private readonly audit: AuditService,
  ) {}

  async onApplicationShutdown() {
    await this.queues.close();
  }

  /** The next run and the local day it will cover. */
  preview(timezone: string, localTime: string) {
    this.checkTime(timezone, localTime);
    const next = nextRunAt(timezone, localTime, this.now());
    const w = reportWindow(timezone, next);
    return { nextRunAt: next, localDate: w.localDate, windowHours: w.hours };
  }

  async list(ctx: TenantContext, productId: string) {
    const rows = await withTenant(this.prisma, ctx, (tx) =>
      tx.reportSchedule.findMany({ where: { productId }, orderBy: { createdAt: 'asc' } }),
    );
    return { schedules: rows.map(scheduleView) };
  }

  async create(ctx: TenantContext, productId: string, input: ScheduleInput) {
    this.checkTime(input.timezone, input.localTime);
    const row = await withTenant(this.prisma, ctx, async (tx) => {
      await this.checkDestinations(tx, input.channelIds, input.recipients);
      const s = await tx.reportSchedule.create({
        data: {
          organizationId: ctx.organizationId,
          productId,
          environmentId: input.environmentId ?? null,
          name: input.name,
          timezone: input.timezone,
          localTime: input.localTime,
          channelIds: input.channelIds,
          recipients: input.recipients,
          enabled: input.enabled ?? true,
          nextRunAt: nextRunAt(input.timezone, input.localTime, this.now()),
          createdByUserId: ctx.actor.kind === 'user' ? ctx.actor.userId : null,
        },
      });
      await this.audit.record(tx, ctx, {
        action: 'report_schedule.create',
        targetType: 'report_schedule',
        targetId: s.id,
        metadata: { name: s.name, timezone: s.timezone, localTime: s.localTime },
      });
      return s;
    });
    return scheduleView(row);
  }

  /**
   * A changed timezone or time moves the next run; a local date that already has a report is
   * never generated twice (unique schedule, date, version).
   */
  async update(ctx: TenantContext, id: string, input: Partial<ScheduleInput>) {
    const row = await withTenant(this.prisma, ctx, async (tx) => {
      const current = await tx.reportSchedule.findUnique({ where: { id } });
      if (!current) throw notFound();
      const next = { ...current, ...input };
      this.checkTime(next.timezone, next.localTime);
      if (input.channelIds || input.recipients)
        await this.checkDestinations(tx, next.channelIds, next.recipients);
      const moved = next.timezone !== current.timezone || next.localTime !== current.localTime;
      const s = await tx.reportSchedule.update({
        where: { id },
        data: {
          ...input,
          ...(moved ? { nextRunAt: nextRunAt(next.timezone, next.localTime, this.now()) } : {}),
        },
      });
      await this.audit.record(tx, ctx, {
        action: 'report_schedule.update',
        targetType: 'report_schedule',
        targetId: id,
        metadata: { changed: Object.keys(input) },
      });
      return s;
    });
    return scheduleView(row);
  }

  async remove(ctx: TenantContext, id: string) {
    await withTenant(this.prisma, ctx, async (tx) => {
      const s = await tx.reportSchedule.findUnique({ where: { id }, select: { name: true } });
      if (!s) throw notFound();
      await tx.reportSchedule.delete({ where: { id } });
      await this.audit.record(tx, ctx, {
        action: 'report_schedule.delete',
        targetType: 'report_schedule',
        targetId: id,
        metadata: { name: s.name },
      });
    });
  }

  /** "Run now": the prior complete local day, as the next version for that date. */
  async run(ctx: TenantContext, id: string) {
    const { localDate, version } = await withTenant(this.prisma, ctx, async (tx) => {
      const s = await tx.reportSchedule.findUnique({ where: { id } });
      if (!s) throw notFound();
      const localDate = reportWindow(s.timezone, this.now()).localDate;
      const version = await this.nextVersion(tx, id, localDate);
      await this.audit.record(tx, ctx, {
        action: 'report_schedule.run',
        targetType: 'report_schedule',
        targetId: id,
        metadata: { localDate, version },
      });
      return { localDate, version };
    });
    await this.queue(ctx, id, localDate, version);
    return { localDate, version };
  }

  async reports(ctx: TenantContext, productId: string) {
    const rows = await withTenant(this.prisma, ctx, (tx) =>
      tx.generatedReport.findMany({
        where: { productId },
        include: { schedule: { select: { name: true } } },
        orderBy: [{ localDate: 'desc' }, { version: 'desc' }],
        take: 100,
      }),
    );
    return { reports: rows.map(reportSummary) };
  }

  async report(ctx: TenantContext, id: string) {
    return withTenant(this.prisma, ctx, async (tx) => {
      const r = await tx.generatedReport.findUnique({
        where: { id },
        include: { schedule: { select: { name: true } }, deliveries: { orderBy: { createdAt: 'asc' } } },
      });
      if (!r) throw notFound();
      const channels = new Map(
        (
          await tx.notificationChannel.findMany({
            where: { id: { in: r.deliveries.flatMap((d) => (d.channelId ? [d.channelId] : [])) } },
            select: { id: true, name: true },
          })
        ).map((c) => [c.id, c.name]),
      );
      return {
        ...reportSummary(r),
        timezone: r.timezone,
        windowStart: r.windowStart,
        windowEnd: r.windowEnd,
        narrative: r.narrative,
        problems: r.problems,
        snapshot: r.snapshot,
        deliveries: r.deliveries.map((d) => ({
          id: d.id,
          kind: d.kind,
          target: d.channelId ? (channels.get(d.channelId) ?? 'Deleted channel') : d.target,
          channelId: d.channelId,
          status: d.status,
          attempts: d.attempts,
          lastError: d.lastError,
          sentAt: d.sentAt,
        })),
      };
    });
  }

  /** UC-15-09: a new version for the same local date; earlier versions stay as they are. */
  async regenerate(ctx: TenantContext, id: string) {
    const { scheduleId, localDate, version } = await withTenant(this.prisma, ctx, async (tx) => {
      const r = await tx.generatedReport.findUnique({ where: { id } });
      if (!r) throw notFound();
      if (!r.scheduleId)
        throw new ApiException(409, 'schedule_deleted', 'The schedule of this report was deleted');
      const localDate = day(r.localDate);
      const version = await this.nextVersion(tx, r.scheduleId, localDate);
      await this.audit.record(tx, ctx, {
        action: 'report.regenerate',
        targetType: 'report',
        targetId: id,
        metadata: { localDate, version },
      });
      return { scheduleId: r.scheduleId, localDate, version };
    });
    await this.queue(ctx, scheduleId, localDate, version);
    return { version };
  }

  private async nextVersion(
    tx: Parameters<Parameters<typeof withTenant>[2]>[0],
    scheduleId: string,
    localDate: string,
  ) {
    const last = await tx.generatedReport.aggregate({
      where: { scheduleId, localDate: new Date(`${localDate}T00:00:00Z`) },
      _max: { version: true },
    });
    return (last._max.version ?? 0) + 1;
  }

  private queue(ctx: TenantContext, scheduleId: string, localDate: string, version: number) {
    return enqueue(
      this.queues,
      'report-generate',
      { organizationId: ctx.organizationId, connectionId: scheduleId, requestId: ctx.requestId },
      `${localDate}__v${version}`,
    );
  }

  private checkTime(timezone: string, localTime: string) {
    if (!isValidTimezone(timezone))
      throw new ApiException(400, 'invalid_timezone', `${timezone} is not an IANA timezone`);
    if (!isValidLocalTime(localTime))
      throw new ApiException(400, 'invalid_time', 'Use a 24-hour local time such as 08:00');
  }

  private async checkDestinations(
    tx: Parameters<Parameters<typeof withTenant>[2]>[0],
    channelIds: string[],
    recipients: string[],
  ) {
    if (channelIds.length === 0 && recipients.length === 0)
      throw new ApiException(400, 'no_destination', 'Choose a channel or add a recipient');
    if (recipients.length > MAX_RECIPIENTS)
      throw new ApiException(400, 'too_many_recipients', `At most ${MAX_RECIPIENTS} recipients`);
    const bad = recipients.find((r) => !EMAIL.test(r));
    if (bad) throw new ApiException(400, 'invalid_recipient', `${bad} is not an email address`);
    // RLS: another organization's channel IDs are simply not found.
    const found = await tx.notificationChannel.count({ where: { id: { in: channelIds } } });
    if (found !== new Set(channelIds).size)
      throw new ApiException(400, 'unknown_channel', 'A selected channel does not exist');
  }
}
