import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AGENT_ROUTE } from '../../common/decorators.js';
import { ApiException } from '../../common/errors.js';
import type { ApiRequest } from '../../common/request.js';
import { CLOCK } from '../../tokens.js';
import { AgentIdentityCache } from './agent-identity.cache.js';
import { AGENT_SETTINGS, type AgentSettings } from './settings.provider.js';

const FINGERPRINT = /^[0-9a-f]{64}$/;

const unauthorized = () => new ApiException(401, 'agent_unauthorized', 'Agent authentication failed');

/** IPv4-mapped IPv6 (`::ffff:a.b.c.d`) compares equal to its IPv4 form. */
const normalize = (address: string | undefined) => (address ?? '').replace(/^::ffff:/, '');

/**
 * Authenticates @AgentRoute requests (D10): the client-certificate fingerprint header is
 * trusted only when the TCP peer is Caddy. `req.ip` is not used, because Fastify's
 * trustProxy derives it from X-Forwarded-For, which any client can send.
 */
@Injectable()
export class AgentAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly cache: AgentIdentityCache,
    @Inject(AGENT_SETTINGS) private readonly settings: AgentSettings | null,
    @Inject(CLOCK) private readonly now: () => Date,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.reflector.getAllAndOverride<boolean>(AGENT_ROUTE, [context.getHandler(), context.getClass()]))
      return true;
    const req = context.switchToHttp().getRequest<ApiRequest>();
    const peer = normalize(req.raw.socket.remoteAddress);
    if (!this.settings?.config.proxyAddresses.includes(peer)) throw unauthorized();
    const header = req.headers['x-client-cert-fingerprint'];
    const fingerprint = typeof header === 'string' ? header.toLowerCase().replace(/:/g, '') : '';
    if (!FINGERPRINT.test(fingerprint)) throw unauthorized();

    const state = await this.cache.get(fingerprint);
    if (!state || !AgentIdentityCache.valid(state, this.now())) throw unauthorized();
    req.agent = {
      id: state.agent_id,
      organizationId: state.organization_id,
      productId: state.product_id,
      environmentId: state.environment_id,
      fingerprint,
    };
    req.tenant = {
      organizationId: state.organization_id,
      actor: { kind: 'agent', agentId: state.agent_id },
      roles: [],
      productIds: [state.product_id],
      environmentIds: [state.environment_id],
      requestId: String(req.id),
    };
    return true;
  }
}
