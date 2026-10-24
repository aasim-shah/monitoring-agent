import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import type { PrismaClient } from '@pcp/database';
import { withTenant } from '@pcp/tenant-security';
import { RequirePermission, TenantScope } from '../../common/decorators.js';
import { ApiException, notFound } from '../../common/errors.js';
import type { ApiRequest } from '../../common/request.js';
import { requireTenant } from '../../common/tenant.js';
import { CLOCK, PRISMA } from '../../tokens.js';
import { agentStatus } from '../agents/status.js';
import { FLEET_QUERIES, HOST_QUERIES, RANGES, type RangeKey } from './host-metrics.js';
import { packById } from '../packs/catalog.js';
import { SERVICE_CHARTS } from './service-metrics.js';
import { TelemetryQueryService } from './query.service.js';

type Point = [number, number | null];

@Controller('api/v1')
export class TelemetryController {
  constructor(
    private readonly telemetry: TelemetryQueryService,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(CLOCK) private readonly now: () => Date,
  ) {}

  @RequirePermission('telemetry.query')
  @TenantScope({ param: 'id', resource: 'agent' })
  @Get('agents/:id/metrics')
  async hostMetrics(@Req() req: ApiRequest, @Param('id') agentId: string, @Query('range') rangeKey = '1h') {
    if (!(rangeKey in RANGES))
      throw new ApiException(400, 'invalid_range', `range must be one of ${Object.keys(RANGES).join(', ')}`);
    const range = RANGES[rangeKey as RangeKey];
    const ctx = requireTenant(req);
    const agent = await withTenant(this.prisma, ctx, (tx) =>
      tx.agent.findUnique({ where: { id: agentId }, select: { productId: true } }),
    );
    if (!agent) throw notFound();
    const end = this.now();
    const q = (promql: string) =>
      this.telemetry.query(
        ctx,
        {
          promql,
          start: new Date(end.getTime() - range.seconds * 1000).toISOString(),
          end: end.toISOString(),
          stepSeconds: range.step,
        },
        { productId: agent.productId, agentId },
      );
    const [cpu, memory, disk, networkIn, networkOut] = await Promise.all([
      q(HOST_QUERIES.cpu),
      q(HOST_QUERIES.memory),
      q(HOST_QUERIES.disk),
      q(HOST_QUERIES.networkIn),
      q(HOST_QUERIES.networkOut),
    ]);
    const single = (r: typeof cpu): Point[] => (r.series[0]?.points as Point[] | undefined) ?? [];
    const cpuPoints = single(cpu);
    const last = [...cpuPoints].reverse().find((p) => p[1] !== null);
    return {
      range: rangeKey,
      stepSeconds: range.step,
      series: {
        cpu: cpuPoints,
        memory: single(memory),
        disk: disk.series.map((s) => ({
          mountpoint: s.labels.mountpoint ?? '',
          points: s.points as Point[],
        })),
        networkIn: single(networkIn),
        networkOut: single(networkOut),
      },
      lastSampleAt: last ? new Date(last[0] * 1000).toISOString() : null,
      completeness: cpu.completeness,
      gaps: cpu.gaps,
    };
  }

  /**
   * Level 2 verification (WB-11 UC-11-04): has the guide's proof metric arrived from this agent in
   * the last 15 minutes? Read-only; the platform never performs the change (BR-11-04).
   */
  @RequirePermission('telemetry.query')
  @TenantScope({ param: 'id', resource: 'agent' })
  @Get('agents/:id/packs/:packId/verification')
  async verifyGuide(@Req() req: ApiRequest, @Param('id') agentId: string, @Param('packId') packId: string) {
    const guide = packById(packId)?.guide;
    if (!guide) throw notFound();
    const ctx = requireTenant(req);
    const agent = await withTenant(this.prisma, ctx, (tx) =>
      tx.agent.findUnique({ where: { id: agentId }, select: { productId: true } }),
    );
    if (!agent) throw notFound();
    const rows = await this.telemetry.instant(
      ctx,
      `count(last_over_time({__name__=~"${guide.proof}"}[15m]))`,
      { productId: agent.productId, agentId },
    );
    const series = rows[0]?.value ?? 0;
    return {
      packId,
      status: series > 0 ? 'active' : 'not_found',
      series,
      proof: guide.proofLabel,
      checkedAt: this.now(),
    };
  }

  /** Charts for one enabled monitoring pack (WB-11): fixed PromQL per pack. */
  @RequirePermission('telemetry.query')
  @TenantScope({ param: 'id', resource: 'agent' })
  @Get('agents/:id/services/:packId/metrics')
  async serviceMetrics(
    @Req() req: ApiRequest,
    @Param('id') agentId: string,
    @Param('packId') packId: string,
    @Query('range') rangeKey = '1h',
  ) {
    const charts = Object.hasOwn(SERVICE_CHARTS, packId) ? SERVICE_CHARTS[packId] : undefined;
    if (!charts) throw notFound();
    if (!(rangeKey in RANGES))
      throw new ApiException(400, 'invalid_range', `range must be one of ${Object.keys(RANGES).join(', ')}`);
    const range = RANGES[rangeKey as RangeKey];
    const ctx = requireTenant(req);
    const agent = await withTenant(this.prisma, ctx, (tx) =>
      tx.agent.findUnique({
        where: { id: agentId },
        select: { productId: true, packs: { where: { packId }, select: { status: true } } },
      }),
    );
    if (!agent || agent.packs.length === 0) throw notFound();
    const end = this.now();
    const results = await Promise.all(
      charts.map((c) =>
        this.telemetry.query(
          ctx,
          {
            promql: c.promql,
            start: new Date(end.getTime() - range.seconds * 1000).toISOString(),
            end: end.toISOString(),
            stepSeconds: range.step,
          },
          { productId: agent.productId, agentId },
        ),
      ),
    );
    return {
      packId,
      range: rangeKey,
      stepSeconds: range.step,
      status: agent.packs[0]!.status,
      charts: charts.map((c, i) => ({
        key: c.key,
        title: c.title,
        unit: c.unit,
        series: results[i]!.series.map((s) => ({
          label: c.label ? c.label(s.labels) : c.title,
          points: s.points as Point[],
        })),
      })),
    };
  }

  @RequirePermission('telemetry.query')
  @TenantScope({ param: 'productId' })
  @Get('products/:productId/infrastructure')
  async infrastructure(@Req() req: ApiRequest, @Param('productId') productId: string) {
    const ctx = requireTenant(req);
    const agents = await withTenant(this.prisma, ctx, (tx) =>
      tx.agent.findMany({
        where: { productId },
        orderBy: { hostname: 'asc' },
        include: { environment: { select: { name: true } } },
      }),
    );
    const scope = { productId };
    const [cpu, memory, disk, lastSample] = await Promise.all([
      this.telemetry.instant(ctx, FLEET_QUERIES.cpu, scope),
      this.telemetry.instant(ctx, FLEET_QUERIES.memory, scope),
      this.telemetry.instant(ctx, FLEET_QUERIES.disk, scope),
      this.telemetry.instant(ctx, FLEET_QUERIES.lastSample, scope),
    ]);
    const byAgent = (rows: typeof cpu) => new Map(rows.map((r) => [r.labels.agent_id, r.value]));
    const [c, m, d, l] = [byAgent(cpu), byAgent(memory), byAgent(disk), byAgent(lastSample)];
    const now = this.now();
    return {
      hosts: agents.map((a) => {
        const last = l.get(a.id);
        return {
          agentId: a.id,
          hostname: a.hostname,
          environmentName: a.environment.name,
          ...agentStatus(a, now),
          cpuPercent: c.get(a.id) ?? null,
          memoryPercent: m.get(a.id) ?? null,
          diskPercent: d.get(a.id) ?? null,
          lastSampleAt: last ? new Date(last * 1000).toISOString() : null,
        };
      }),
    };
  }
}
