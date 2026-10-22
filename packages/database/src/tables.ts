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
  'agent_enrollments',
  'agents',
  'agent_credentials',
  'agent_public_keys',
  'agent_heartbeats',
  'agent_tasks',
  'agent_task_results',
  'agent_stream_sessions',
  'agent_inventories',
  'agent_pack_assignments',
] as const;

export type TenantTable = (typeof TENANT_TABLES)[number];
