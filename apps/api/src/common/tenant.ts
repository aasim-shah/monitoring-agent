import type { TenantContext } from '@pcp/shared-contracts';
import type { ApiRequest } from './request.js';

export function requireTenant(req: ApiRequest): TenantContext {
  if (!req.tenant) throw new Error('tenant missing: route must use @RequirePermission and @TenantScope');
  return req.tenant;
}

/** Maps a Prisma unique-constraint violation to `onConflict()`. */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}
