import { beforeEach, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@pcp/database';
import type { TenantContext } from '@pcp/shared-contracts';
import { localDayWindow } from '@pcp/reports';
const tx = vi.hoisted(() => ({
  connection: { findMany: vi.fn() },
  metricAggregate: { findMany: vi.fn() },
  syncRun: { findMany: vi.fn() },
}));
vi.mock('@pcp/tenant-security', () => ({
  withTenant: async (_p: unknown, _c: unknown, fn: (t: unknown) => unknown) => fn(tx),
}));
import { createReportSources } from './report-sources.js';
const ctx: TenantContext = {
  organizationId: 'org',
  actor: { kind: 'system', jobId: 'job' },
  roles: ['owner'],
  productIds: 'all',
  environmentIds: 'all',
  requestId: 'req',
};
beforeEach(() => vi.clearAllMocks());
it('reads only the product scope, labels UTC buckets, and preserves stale source warnings', async () => {
  tx.connection.findMany.mockResolvedValue([
    {
      id: 'aws',
      displayName: 'AWS',
      scopes: [
        { resourceType: 'aws_cost_account', externalId: 'aws-cost:123', name: 'Shared account costs' },
      ],
    },
  ]);
  tx.metricAggregate.findMany.mockResolvedValue([
    {
      connectionId: 'aws',
      resourceType: 'aws_cost_account',
      externalId: 'aws-cost:123',
      metric: 'cost_usd',
      dimension: '',
      value: 12.5,
      completeness: 'partial',
      fetchedAt: new Date('2026-10-26T00:00:00Z'),
    },
    {
      connectionId: 'aws',
      resourceType: 'aws_cost_account',
      externalId: 'not-scoped',
      metric: 'cost_usd',
      dimension: '',
      value: 99999,
      completeness: 'complete',
      fetchedAt: new Date('2026-10-26T00:00:00Z'),
    },
  ]);
  tx.syncRun.findMany.mockResolvedValue([
    { connectionId: 'aws', status: 'succeeded', errorMessage: 'Cost Explorer: rate limited' },
  ]);
  const source = createReportSources({ prisma: {} as PrismaClient })(ctx, 'product');
  const stats = await source.aws!(localDayWindow('Asia/Karachi', '2026-10-25'));
  expect(tx.connection.findMany.mock.calls[0]![0].where.scopes).toEqual({ some: { productId: 'product' } });
  expect(stats?.timezone).toBe('UTC');
  expect(stats?.resources[0]?.values[0]?.value).toBe(12.5);
  expect(stats?.gaps.join(' ')).toContain('independently');
  expect(stats?.gaps.join(' ')).toContain('rate limited');
  expect(stats?.resources[0]?.partial).toBe(true);
  expect(JSON.stringify(stats)).not.toContain('99999');
});
it('omits AWS sections when the product has no scoped AWS connection', async () => {
  tx.connection.findMany.mockResolvedValue([]);
  const source = createReportSources({ prisma: {} as PrismaClient })(ctx, 'other-product');
  expect(await source.aws!(localDayWindow('UTC', '2026-10-25'))).toBeNull();
  expect(tx.metricAggregate.findMany).not.toHaveBeenCalled();
});
