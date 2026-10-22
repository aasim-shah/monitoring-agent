import { Inject, Injectable } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@pcp/database';
import type { TenantContext } from '@pcp/shared-contracts';
import { withTenant } from '@pcp/tenant-security';
import { notFound } from '../../common/errors.js';
import { CLOCK, PRISMA } from '../../tokens.js';
import { agentStatus } from './status.js';

const summaryInclude = { environment: { select: { name: true } } } satisfies Prisma.AgentInclude;
type AgentRow = Prisma.AgentGetPayload<{ include: typeof summaryInclude }>;

/** Fleet views for the dashboard (WB-03 §8). */
@Injectable()
export class AgentsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(CLOCK) private readonly now: () => Date,
  ) {}

  private summary(a: AgentRow, duplicates: Set<string>) {
    return {
      id: a.id,
      hostname: a.hostname,
      os: a.os,
      arch: a.arch,
      agentVersion: a.agentVersion,
      environmentId: a.environmentId,
      environmentName: a.environment.name,
      ...agentStatus(a, this.now()),
      lastHeartbeatAt: a.lastHeartbeatAt,
      clockSkewSeconds: a.clockSkewSeconds,
      duplicateMachineId: duplicates.has(a.machineId),
      createdAt: a.createdAt,
    };
  }

  /** Machine IDs shared by more than one live agent in the organization (cloned images). */
  private async duplicateMachineIds(
    tx: Prisma.TransactionClient,
    machineIds: string[],
  ): Promise<Set<string>> {
    if (!machineIds.length) return new Set();
    const groups = await tx.agent.groupBy({
      by: ['machineId'],
      where: { machineId: { in: machineIds }, status: 'active' },
      _count: { _all: true },
    });
    return new Set(groups.filter((g) => g._count._all > 1).map((g) => g.machineId));
  }

  list(ctx: TenantContext, productId: string) {
    return withTenant(this.prisma, ctx, async (tx) => {
      const rows = await tx.agent.findMany({
        where: { productId },
        orderBy: [{ status: 'asc' }, { hostname: 'asc' }],
        include: summaryInclude,
      });
      const duplicates = await this.duplicateMachineIds(
        tx,
        rows.map((r) => r.machineId),
      );
      return rows.map((r) => this.summary(r, duplicates));
    });
  }

  get(ctx: TenantContext, agentId: string) {
    return withTenant(this.prisma, ctx, async (tx) => {
      const a = await tx.agent.findUnique({
        where: { id: agentId },
        include: {
          ...summaryInclude,
          credentials: { where: { revokedAt: null }, orderBy: { createdAt: 'desc' }, take: 1 },
          heartbeats: { orderBy: { receivedAt: 'desc' }, take: 20 },
        },
      });
      if (!a) throw notFound();
      const duplicates = await this.duplicateMachineIds(tx, [a.machineId]);
      const cert = a.credentials[0];
      return {
        ...this.summary(a, duplicates),
        capabilities: a.capabilities,
        policyVersion: a.policyVersion,
        certificate: cert ? { notAfter: cert.notAfter, fingerprintSha256: cert.fingerprintSha256 } : null,
        recentHeartbeats: a.heartbeats.map((h) => ({
          receivedAt: h.receivedAt,
          health: h.health,
          queueDepth: h.queueDepth,
        })),
      };
    });
  }
}
