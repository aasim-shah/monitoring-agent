import { z } from 'zod';

export const TOOL_NAMES = [
  'listProducts',
  'listAssets',
  'getAssetDetails',
  'getDependencies',
  'getPotentialImpact',
  'getConnectionHealth',
  'getInfrastructureMetrics',
  'getApplicationMetrics',
  'getWebsiteAvailability',
  'getApplicationErrors',
  'getAnalyticsReport',
  'getAdPerformance',
  'getDatabaseHealth',
  'getDeployments',
  'getIncidents',
  'comparePeriods',
  'generateReport',
  'proposeAction',
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export const evidenceSchema = z
  .object({
    id: z.string(),
    sourceType: z.string(),
    sourceId: z.string(),
    assetId: z.string().optional(),
    periodStart: z.string().datetime(),
    periodEnd: z.string().datetime(),
    observedAt: z.string().datetime(),
    coverage: z.enum(['complete', 'partial', 'unavailable']),
  })
  .strict();
export type Evidence = z.infer<typeof evidenceSchema>;

export interface ToolResult<O> {
  data: O;
  evidence: Evidence[];
  gaps: string[];
}
