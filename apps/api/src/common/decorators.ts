import { SetMetadata, applyDecorators } from '@nestjs/common';
import type { Permission } from '@pcp/shared-contracts';

export const IS_PUBLIC = 'pcp:public';
export const SESSION_ONLY = 'pcp:session-only';
export const ALLOW_MFA_PENDING = 'pcp:allow-mfa-pending';
export const REQUIRED_PERMISSION = 'pcp:permission';
export const TENANT_SCOPE = 'pcp:tenant-scope';
export const AGENT_ROUTE = 'pcp:agent-route';
export const AGENT_ENROLL = 'pcp:agent-enroll';

export type TenantResource = 'organization' | 'product' | 'environment' | 'connection';

/** Route parameter that identifies the tenant resource; `orgId`, `productId`, `environmentId` imply theirs. */
export type TenantScopeOptions =
  | { param: 'orgId' | 'productId' | 'environmentId' }
  | { param: string; resource: TenantResource };

/** No session required. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Session required, but the route is not tied to one organization (e.g. /me, create organization). */
export const SessionOnly = () => SetMetadata(SESSION_ONLY, true);

/** Reachable before the second factor is verified or enrolled (MFA, logout, /me). Implies @SessionOnly. */
export const AllowMfaPending = () => applyDecorators(SetMetadata(ALLOW_MFA_PENDING, true), SessionOnly());

/** Permission the caller needs in the route's organization (and product, when scoped). */
export const RequirePermission = (permission: Permission) => SetMetadata(REQUIRED_PERMISSION, permission);

/** Which route parameter identifies the tenant resource. */
export const TenantScope = (scope: TenantScopeOptions) => SetMetadata(TENANT_SCOPE, scope);

/** Agent bootstrap (`POST /agent/v1/enroll`): no session and no certificate yet; the token is the credential. */
export const AgentEnroll = () => applyDecorators(Public(), SetMetadata(AGENT_ENROLL, true));
