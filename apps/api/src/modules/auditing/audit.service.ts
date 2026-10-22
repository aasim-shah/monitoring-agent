import { Inject, Injectable } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@pcp/database';
import type { TenantContext } from '@pcp/shared-contracts';
import { withTenant } from '@pcp/tenant-security';
import { PRISMA } from '../../tokens.js';

export interface AuditEvent {
  action: string;
  targetType: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}

interface Cursor {
  t: string;
  id: string;
}

const encodeCursor = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString('base64url');
function decodeCursor(text: string): Cursor | null {
  try {
    const c = JSON.parse(Buffer.from(text, 'base64url').toString()) as Cursor;
    return typeof c.t === 'string' && typeof c.id === 'string' && !Number.isNaN(Date.parse(c.t)) ? c : null;
  } catch {
    return null;
  }
}

/** Append-only audit trail. Record inside the same transaction as the change it describes. */
@Injectable()
export class AuditService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async record(tx: Prisma.TransactionClient, ctx: TenantContext, event: AuditEvent): Promise<void> {
    const actor = ctx.actor;
    await tx.auditLog.create({
      data: {
        organizationId: ctx.organizationId,
        actorType: actor.kind,
        actorId: actor.kind === 'user' ? actor.userId : actor.kind === 'agent' ? actor.agentId : actor.jobId,
        action: event.action,
        targetType: event.targetType,
        targetId: event.targetId,
        metadata: (event.metadata ?? {}) as Prisma.InputJsonValue,
        requestId: ctx.requestId,
      },
    });
  }

  /** Newest first; `before` is the opaque cursor from a previous page. */
  list(ctx: TenantContext, opts: { limit: number; before?: string }) {
    const cursor = opts.before ? decodeCursor(opts.before) : null;
    return withTenant(this.prisma, ctx, async (tx) => {
      const rows = await tx.auditLog.findMany({
        where: cursor
          ? {
              OR: [
                { createdAt: { lt: new Date(cursor.t) } },
                { createdAt: new Date(cursor.t), id: { lt: cursor.id } },
              ],
            }
          : {},
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: opts.limit,
      });
      const last = rows.at(-1);
      return {
        entries: rows.map((r) => ({
          id: r.id,
          action: r.action,
          actorType: r.actorType,
          actorId: r.actorId,
          targetType: r.targetType,
          targetId: r.targetId,
          metadata: r.metadata,
          requestId: r.requestId,
          createdAt: r.createdAt,
        })),
        nextBefore:
          rows.length === opts.limit && last
            ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id })
            : null,
      };
    });
  }
}
