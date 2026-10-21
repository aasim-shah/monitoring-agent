import type { Prisma, PrismaClient } from '@pcp/database';
import type { TenantContext } from '@pcp/shared-contracts';

/**
 * Runs `fn` in a transaction whose row-level security context is the caller's
 * tenant (ADR 0003). Settings are transaction-local, so a pooled connection never
 * carries them to the next borrower.
 */
export function withTenant<T>(
  prisma: PrismaClient,
  ctx: TenantContext,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.organization_id', ${ctx.organizationId}, true)`;
      if (ctx.actor.kind === 'user') {
        await tx.$queryRaw`SELECT set_config('app.user_id', ${ctx.actor.userId}, true)`;
      }
      return fn(tx);
    },
    { maxWait: 5_000, timeout: 15_000 },
  );
}
