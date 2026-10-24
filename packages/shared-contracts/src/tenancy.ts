import { z } from 'zod';

export const ROLES = ['owner', 'admin', 'operator', 'analyst', 'viewer'] as const;
export type Role = (typeof ROLES)[number];
export const roleSchema = z.enum(ROLES);

export const PERMISSIONS = [
  'org.view',
  'org.members.manage',
  'org.settings.manage',
  /** Owner only: tenant data export and deletion (WB-17 UC-17-09). */
  'org.export',
  'org.delete',
  'product.view',
  'product.manage',
  'connection.view',
  'connection.configure',
  'agent.view',
  'agent.enroll',
  'agent.revoke',
  'pack.manage',
  'asset.view',
  'relationship.verify',
  'telemetry.query',
  'logs.tail',
  'data.inspect',
  'incident.view',
  'incident.manage',
  'policy.manage',
  'action.propose',
  'action.approve',
  'report.view',
  'report.manage',
  'ai.use',
  'audit.view',
] as const;
export type Permission = (typeof PERMISSIONS)[number];
export const permissionSchema = z.enum(PERMISSIONS);

export type Actor =
  | { kind: 'user'; userId: string }
  | { kind: 'agent'; agentId: string }
  | { kind: 'system'; jobId: string };

export interface TenantContext {
  organizationId: string;
  actor: Actor;
  roles: Role[];
  productIds: string[] | 'all';
  environmentIds: string[] | 'all';
  requestId: string;
}
