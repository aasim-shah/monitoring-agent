import { createHash, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import { APP_CONFIG } from '../tokens.js';
import { INTERNAL_ROUTE } from './decorators.js';
import { ApiException, notFound } from './errors.js';

const digest = (v: string) => createHash('sha256').update(v).digest();

/**
 * Guards @Internal routes: off (404) when INTERNAL_TOKEN is unset; otherwise the
 * `X-Internal-Token` header must match, compared in constant time. Caddy never routes
 * /internal, so only services on the private network can reach these.
 */
@Injectable()
export class InternalGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (
      !this.reflector.getAllAndOverride<boolean>(INTERNAL_ROUTE, [context.getHandler(), context.getClass()])
    )
      return true;
    if (!this.config.internalToken) throw notFound();
    const header = context.switchToHttp().getRequest<FastifyRequest>().headers['x-internal-token'];
    const given = typeof header === 'string' ? header : '';
    if (!timingSafeEqual(digest(given), digest(this.config.internalToken)))
      throw new ApiException(401, 'unauthenticated', 'Internal token required');
    return true;
  }
}
