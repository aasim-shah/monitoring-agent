import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PrismaClient } from '@pcp/database';
import { ALLOW_MFA_PENDING, IS_PUBLIC } from '../../common/decorators.js';
import { SESSION_COOKIE } from '../../common/cookies.js';
import { ApiException } from '../../common/errors.js';
import type { ApiRequest } from '../../common/request.js';
import { PRISMA } from '../../tokens.js';
import { SessionService } from './session.service.js';

const mfaRequired = () => new ApiException(403, 'mfa_required', 'Two-factor authentication is required');

/**
 * Resolves the session cookie for every non-public route and enforces MFA:
 * users with MFA must verify it per session; owners and admins must enroll (§3).
 */
@Injectable()
export class CurrentUserGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = context.switchToHttp().getRequest<ApiRequest>();
    const token = req.cookies?.[SESSION_COOKIE];
    const session = token ? await this.sessions.resolve(token) : null;
    if (!token || !session) throw new ApiException(401, 'unauthenticated', 'Sign in required');
    const user = await this.prisma.user.findUnique({ where: { id: session.userId } });
    if (!user) throw new ApiException(401, 'unauthenticated', 'Sign in required');

    req.auth = {
      user: { id: user.id, email: user.email, mfaEnabled: Boolean(user.mfaEnabledAt) },
      session: { id: session.id, mfaVerified: session.mfaVerified },
      token,
    };

    if (this.reflector.getAllAndOverride<boolean>(ALLOW_MFA_PENDING, targets)) return true;
    if (user.mfaEnabledAt && !session.mfaVerified) throw mfaRequired();
    if (!user.mfaEnabledAt) {
      const privileged = await this.prisma.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pcp_user_memberships(${user.id}::uuid) WHERE role IN ('owner', 'admin')`;
      if ((privileged[0]?.n ?? 0) > 0) throw mfaRequired();
    }
    return true;
  }
}
