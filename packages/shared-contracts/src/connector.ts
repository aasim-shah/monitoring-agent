import { z } from 'zod';

export const CONNECTOR_CAPABILITIES = [
  'authenticate',
  'config_validation',
  'validate',
  'discover',
  'sync',
  'health',
  'metrics',
  'events',
  'webhook_registration',
  'credential_refresh',
  'actions',
] as const;
export type ConnectorCapability = (typeof CONNECTOR_CAPABILITIES)[number];
export const connectorCapabilitySchema = z.enum(CONNECTOR_CAPABILITIES);

export const CONNECTION_STATUSES = [
  'draft',
  'pending_auth',
  'pending_validation',
  'connected',
  'degraded',
  'disconnected',
  'revoked',
] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export const CONNECTION_REASONS = [
  'reauthorization_required',
  'rate_limited',
  'permission_denied',
  'provider_unavailable',
] as const;
export type ConnectionReason = (typeof CONNECTION_REASONS)[number];

export const OBSERVATION_SOURCES = ['provider_api', 'agent', 'sdk', 'manual', 'webhook'] as const;

export const observationSchema = z
  .object({
    connectionId: z.string().optional(),
    agentId: z.string().optional(),
    source: z.enum(OBSERVATION_SOURCES),
    provider: z.string().min(1),
    resourceType: z.string().min(1),
    externalId: z.string().optional(),
    attributes: z.record(z.string(), z.unknown()),
    observedAt: z.string().datetime(),
    method: z.string().min(1),
    confidence: z.number().min(0).max(1),
    evidence: z.record(z.string(), z.unknown()),
  })
  .strict();
export type Observation = z.infer<typeof observationSchema>;

export interface DiscoveryPage {
  observations: Observation[];
  nextCursor?: string;
}

export const metricQuerySchema = z
  .object({
    promql: z.string().min(1).max(4096),
    start: z.string().datetime(),
    end: z.string().datetime(),
    stepSeconds: z.number().int().positive().optional(),
    assetId: z.string().optional(),
  })
  .strict();
export type MetricQuery = z.infer<typeof metricQuerySchema>;

export interface MetricResult {
  /** `[epochSeconds, value]`; `null` marks a step with no data (never shown as zero, BR-04-07). */
  series: Array<{ labels: Record<string, string>; points: Array<[number, number | null]> }>;
  freshness: 'current' | 'stale' | 'unavailable';
  completeness: 'complete' | 'partial' | 'unavailable';
  gaps: string[];
}
