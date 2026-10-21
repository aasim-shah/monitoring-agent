import type { FastifyRequest } from 'fastify';
import type { TenantContext } from '@pcp/shared-contracts';

export interface AuthInfo {
  user: { id: string; email: string; mfaEnabled: boolean };
  session: { id: string; mfaVerified: boolean };
  token: string;
}

export type ApiRequest = FastifyRequest & { auth?: AuthInfo; tenant?: TenantContext };

export function requireAuth(req: ApiRequest): AuthInfo {
  if (!req.auth) throw new Error('auth missing: route must not be @Public');
  return req.auth;
}
