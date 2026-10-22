import type { Prisma } from '@pcp/database';
import type { AssetSource } from './ingest.js';

type Tx = Prisma.TransactionClient;

/** UC-10-08: an asset becomes `missing` after 3 consecutive completed runs of its source that did not see it. */
export const MISSING_AFTER_RUNS = 3;

export async function startRun(
  tx: Tx,
  organizationId: string,
  productId: string,
  source: AssetSource,
): Promise<string> {
  const run = await tx.discoveryRun.create({
    data: { organizationId, productId, source, status: 'running' },
  });
  return run.id;
}

export async function completeRun(
  tx: Tx,
  organizationId: string,
  runId: string,
  seenAssetIds: string[],
): Promise<{ missed: number; missing: number }> {
  const run = await tx.discoveryRun.findUniqueOrThrow({ where: { id: runId } });
  const scope = {
    source: run.source,
    lifecycle: { notIn: ['retired', 'manually_managed'] as Array<'retired' | 'manually_managed'> },
    products: { some: { productId: run.productId } },
  };
  if (seenAssetIds.length)
    await tx.asset.updateMany({ where: { ...scope, id: { in: seenAssetIds } }, data: { missedRuns: 0 } });
  const missed = await tx.asset.updateMany({
    where: { ...scope, id: { notIn: seenAssetIds } },
    data: { missedRuns: { increment: 1 } },
  });
  const missing = await tx.asset.updateMany({
    where: {
      ...scope,
      id: { notIn: seenAssetIds },
      missedRuns: { gte: MISSING_AFTER_RUNS },
      lifecycle: { notIn: ['retired', 'manually_managed', 'missing'] },
    },
    data: { lifecycle: 'missing' },
  });
  await tx.discoveryRun.update({
    where: { id: runId },
    data: {
      status: 'succeeded',
      completedAt: new Date(),
      stats: { seen: seenAssetIds.length, missed: missed.count, missing: missing.count },
    },
  });
  return { missed: missed.count, missing: missing.count };
}
