/** Tables with forced row-level security. Every new tenant table must be added here. */
export const TENANT_TABLES = [
  'organizations',
  'organization_members',
  'invitations',
  'products',
  'environments',
  'teams',
  'audit_logs',
  'connections',
  'connection_secrets',
  'connection_resource_scopes',
  'connection_health',
  'sync_runs',
  'job_definitions',
  'job_executions',
] as const;

export type TenantTable = (typeof TENANT_TABLES)[number];
