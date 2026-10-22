import { Inject, Injectable } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@pcp/database';
import type { TenantContext } from '@pcp/shared-contracts';
import { withTenant } from '@pcp/tenant-security';
import { notFound } from '../../common/errors.js';
import { CLOCK, PRISMA } from '../../tokens.js';
import { AuditService } from '../auditing/audit.service.js';
import { RevocationBus } from './revocation.bus.js';
import { agentStatus } from './status.js';

const summaryInclude = { environment: { select: { name: true } } } satisfies Prisma.AgentInclude;
type AgentRow = Prisma.AgentGetPayload<{ include: typeof summaryInclude }>;

/** Fleet views for the dashboard (WB-03 §8). */
@Injectable()
export class AgentsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(CLOCK) private readonly now: () => Date,
    private readonly audit: AuditService,
    private readonly revocations: RevocationBus,
  ) {}

  private summary(a: AgentRow, duplicates: Set<string>) {
    return {
      id: a.id,
      agentType: a.agentType,
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
          publicKeys: { where: { kind: 'x25519' } },
        },
      });
      if (!a) throw notFound();
      const duplicates = await this.duplicateMachineIds(tx, [a.machineId]);
      const cert = a.credentials[0];
      return {
        ...this.summary(a, duplicates),
        capabilities: a.capabilities,
        policyVersion: a.policyVersion,
        // Pack credentials are sealed to this key in the browser (D24).
        x25519PublicKey: a.publicKeys[0]?.publicKey ?? null,
        certificate: cert ? { notAfter: cert.notAfter, fingerprintSha256: cert.fingerprintSha256 } : null,
        recentHeartbeats: a.heartbeats.map((h) => ({
          receivedAt: h.receivedAt,
          health: h.health,
          queueDepth: h.queueDepth,
        })),
      };
    });
  }

  /**
   * Revocation (UC-03-06): the agent and every certificate stop authenticating at once on
   * all API processes; undelivered and in-flight tasks are expired.
   */
  async revoke(ctx: TenantContext, agentId: string): Promise<{ status: 'revoked' }> {
    const now = this.now();
    const fingerprints = await withTenant(this.prisma, ctx, async (tx) => {
      const agent = await tx.agent.findUnique({ where: { id: agentId }, include: { credentials: true } });
      if (!agent) throw notFound();
      if (agent.status === 'revoked') return [];
      await tx.agent.update({ where: { id: agentId }, data: { status: 'revoked', revokedAt: now } });
      await tx.agentCredential.updateMany({ where: { agentId, revokedAt: null }, data: { revokedAt: now } });
      await tx.agentTask.updateMany({
        where: { agentId, status: { in: ['queued', 'delivered'] } },
        data: { status: 'expired' },
      });
      await tx.agentStreamSession.updateMany({
        where: { agentId, status: 'open' },
        data: { status: 'closed' },
      });
      await this.audit.record(tx, ctx, {
        action: 'agent.revoked',
        targetType: 'agent',
        targetId: agentId,
        metadata: { hostname: agent.hostname },
      });
      return agent.credentials.map((c) => c.fingerprintSha256);
    });
    await this.revocations.publish(fingerprints);
    return { status: 'revoked' };
  }
}
