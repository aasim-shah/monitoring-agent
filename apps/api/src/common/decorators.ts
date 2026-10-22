import { SetMetadata, applyDecorators } from '@nestjs/common';
import type { Permission } from '@pcp/shared-contracts';

export const IS_PUBLIC = 'pcp:public';
export const SESSION_ONLY = 'pcp:session-only';
export const ALLOW_MFA_PENDING = 'pcp:allow-mfa-pending';
export const REQUIRED_PERMISSION = 'pcp:permission';
export const TENANT_SCOPE = 'pcp:tenant-scope';

export type TenantScopeParam = 'orgId' | 'productId' | 'environmentId';

/** No session required. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Session required, but the route is not tied to one organization (e.g. /me, create organization). */
export const SessionOnly = () => SetMetadata(SESSION_ONLY, true);

/** Reachable before the second factor is verified or enrolled (MFA, logout, /me). Implies @SessionOnly. */
export const AllowMfaPending = () => applyDecorators(SetMetadata(ALLOW_MFA_PENDING, true), SessionOnly());

/** Permission the caller needs in the route's organization (and product, when scoped). */
export const RequirePermission = (permission: Permission) => SetMetadata(REQUIRED_PERMISSION, permission);

/** Which route parameter identifies the tenant resource. */
export const TenantScope = (scope: { param: TenantScopeParam }) => SetMetadata(TENANT_SCOPE, scope);
