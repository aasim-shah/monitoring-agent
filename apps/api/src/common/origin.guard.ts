import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import { APP_CONFIG } from '../tokens.js';
import { ApiException } from './errors.js';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Rejects state-changing browser requests from another origin (defense in depth with SameSite=Lax). */
@Injectable()
export class OriginGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const origin = req.headers.origin;
    if (SAFE.has(req.method) || origin === undefined) return true;
    if (origin !== this.config.appOrigin)
      throw new ApiException(403, 'forbidden_origin', 'Cross-origin request refused');
    return true;
  }
}
