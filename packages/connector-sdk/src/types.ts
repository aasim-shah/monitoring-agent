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

export interface SyncPage {
  observations: Observation[];
  nextCursor?: string;
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
  sync?(ctx: ExecutionContext, cursor?: string): Promise<SyncPage>;
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
