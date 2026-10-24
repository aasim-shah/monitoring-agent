import type {
  ConnectorCapability,
  DiscoveryPage,
  MetricQuery,
  MetricResult,
  Observation,
} from '@pcp/shared-contracts';
import type { ReadOnlyTemplate } from './templates.js';
import type { WebhookCheck, WebhookRequest } from './webhooks.js';

export type ExecutionLocation = 'cloud' | 'private';

/** Built by the runtime from the authenticated context; connectors never set tenant identity. */
export interface ExecutionContext {
  authenticatedOrganizationId: string;
  productId?: string;
  environmentId?: string;
  connectionId: string;
  executionLocation: ExecutionLocation;
  requestId: string;
  /** ISO-8601 deadline for the operation. */
  deadline: string;
  /** Non-secret connection configuration. */
  config: Record<string, unknown>;
  /** Decrypted credentials, loaded on demand. */
  credentials(): Promise<Record<string, string>>;
  /** OAuth connections: the scopes the provider granted (BR-08-03). */
  grantedScopes?: string[];
}

export interface ConfigValidation {
  ok: boolean;
  errors?: string[];
}

export interface ConnectionValidation {
  ok: boolean;
  accountId?: string;
  missingPermissions?: string[];
}

export interface HealthResult {
  ok: boolean;
  detail?: string;
  /** Structured health fields (e.g. database connections, sizes, replication lag). */
  data?: Record<string, unknown>;
}

export interface TemplateResult {
  rows: Record<string, unknown>[];
  /** More than the 1,000-row limit matched (BR-07-04). */
  truncated: boolean;
}

export interface CredentialField {
  name: string;
  label: string;
  secret: boolean;
  /** Default true; optional fields allow alternative forms (e.g. a connection string or username/password). */
  required?: boolean;
}

/** One daily value for a scoped resource (M13b). A day the provider could not answer has no point. */
export interface MetricPoint {
  resourceType: string;
  externalId: string;
  metric: string;
  /** A breakdown value (e.g. a channel group); absent for the total. */
  dimension?: string;
  /** YYYY-MM-DD in the provider's reporting timezone. */
  day: string;
  value: number | null;
  /** `partial` while the provider is still processing that day. */
  completeness: 'complete' | 'partial';
}

export interface SyncInput {
  /** The resources scoped to a product; only these are read. */
  scopes: Array<{ resourceType: string; externalId: string }>;
  /** How many days back to read, today included. */
  days: number;
}

export interface SyncResult {
  points: MetricPoint[];
  /** Services that could not be read this run, in words (e.g. "Search Console: permission denied"). */
  gaps: string[];
}

/** Connector contract (spec §9). Declare a capability if and only if its method exists. */
export interface Connector {
  readonly type: string;
  readonly version: string;
  readonly displayName: string;
  readonly executionLocations: ExecutionLocation[];
  readonly credentialFields: CredentialField[];
  capabilities(): ConnectorCapability[];
  /** JSON Schema of the non-secret configuration. */
  configSchema(): Record<string, unknown>;
  validateConfig?(config: unknown): ConfigValidation;
  beginAuthorization?(
    ctx: ExecutionContext,
    input: Record<string, unknown>,
  ): Promise<{ redirectUrl: string }>;
  completeAuthorization?(
    ctx: ExecutionContext,
    input: Record<string, unknown>,
  ): Promise<{ credentials: Record<string, string> }>;
  validate(ctx: ExecutionContext): Promise<ConnectionValidation>;
  discover?(ctx: ExecutionContext, cursor?: string): Promise<DiscoveryPage>;
  /** Daily KPI values for the scoped resources (M13b). */
  sync?(ctx: ExecutionContext, input: SyncInput): Promise<SyncResult>;
  health?(ctx: ExecutionContext): Promise<HealthResult>;
  collect?(ctx: ExecutionContext, query: MetricQuery): Promise<MetricResult>;
  /**
   * Checks a webhook's signature with this connection's credentials (WB-06 UC-06-10). Called
   * before anything else; a false result is answered 401 without reading the payload further.
   */
  verifyWebhook?(req: WebhookRequest, credentials: Record<string, string>): WebhookCheck;
  /**
   * Normalizes a verified event. `change_event` observations become change events
   * (attributes: kind, title, url?, actor?, occurredAt, externalId); `connection_revoked`
   * revokes the connection; anything else is ignored.
   */
  ingestEvent?(
    ctx: ExecutionContext,
    event: { eventType: string; headers: Record<string, string>; payload: unknown },
  ): Promise<Observation[]>;
  registerWebhook?(ctx: ExecutionContext): Promise<{ url: string }>;
  refreshCredential?(ctx: ExecutionContext): Promise<{ credentials: Record<string, string> }>;
  executeAction?(ctx: ExecutionContext, action: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Named read-only templates this connector can run (BR-07-02). */
  readonly templates?: ReadOnlyTemplate[];
  runTemplate?(
    ctx: ExecutionContext,
    name: string,
    params: { from: string; to: string },
  ): Promise<TemplateResult>;
}

export interface CatalogEntry {
  type: string;
  version: string;
  displayName: string;
  capabilities: ConnectorCapability[];
  executionLocations: ExecutionLocation[];
  credentialFields: CredentialField[];
  configSchema: Record<string, unknown>;
}
