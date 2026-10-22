import type { FastifyRequest } from 'fastify';
import type { TenantContext } from '@pcp/shared-contracts';

export interface AuthInfo {
  user: { id: string; email: string; mfaEnabled: boolean };
  session: { id: string; mfaVerified: boolean };
  token: string;
}

/** The authenticated agent; tenant scope comes from its enrollment, never from the request. */
export interface AgentIdentity {
  id: string;
  organizationId: string;
  productId: string;
  environmentId: string;
  fingerprint: string;
  /** The agent's egress IP as Caddy saw it (last X-Forwarded-For entry, set by the trusted proxy). */
  clientIp?: string;
}

export type ApiRequest = FastifyRequest & { auth?: AuthInfo; tenant?: TenantContext; agent?: AgentIdentity };

export function requireAgent(req: ApiRequest): AgentIdentity {
  if (!req.agent) throw new Error('agent missing: route must use @AgentRoute');
  return req.agent;
}

export function requireAuth(req: ApiRequest): AuthInfo {
  if (!req.auth) throw new Error('auth missing: route must not be @Public');
  return req.auth;
}
