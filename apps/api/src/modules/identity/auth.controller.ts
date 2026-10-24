import { Body, Controller, Get, HttpCode, Inject, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import {
  OAUTH_STATE_COOKIE,
  clearOAuthStateCookie,
  clearSessionCookie,
  setOAuthStateCookie,
  setSessionCookie,
} from '../../common/cookies.js';
import { AllowMfaPending, Public } from '../../common/decorators.js';
import { ApiException, parseBody } from '../../common/errors.js';
import { requireAuth, type ApiRequest } from '../../common/request.js';
import type { AppConfig } from '../../config.js';
import { APP_CONFIG } from '../../tokens.js';
import { AuthService } from './auth.service.js';
import { GoogleLoginService } from './google-login.service.js';
import { OidcLoginService } from './oidc-login.service.js';
import { MfaService } from './mfa.service.js';
import { RateLimiter } from './rate-limiter.js';
import { SessionService } from './session.service.js';
import {
  googleCallbackQuery,
  loginBody,
  mfaVerifyBody,
  resetBody,
  resetRequestBody,
  signupBody,
  tokenBody,
} from './schemas.js';

@Controller('api/v1/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly mfa: MfaService,
    private readonly google: GoogleLoginService,
    private readonly oidc: OidcLoginService,
    private readonly sessions: SessionService,
    private readonly limiter: RateLimiter,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** 10 requests/min/IP per endpoint group (master plan §3). */
  private async limit(req: ApiRequest, group: string) {
    const { allowed, retryAfterSeconds } = await this.limiter.hit(`auth:${group}:${req.ip}`);
    if (!allowed) {
      throw new ApiException(429, 'rate_limited', 'Too many attempts; try again later', {
        'retry-after': String(retryAfterSeconds),
      });
    }
  }

  @Public()
  @Post('signup')
  @HttpCode(202)
  async signup(@Req() req: ApiRequest, @Body() body: unknown) {
    await this.limit(req, 'signup');
    const { email, password } = parseBody(signupBody, body);
    await this.auth.signup(email, password);
    return { status: 'accepted' };
  }

  @Public()
  @Post('verify')
  @HttpCode(204)
  async verify(@Body() body: unknown) {
    await this.auth.verifyEmail(parseBody(tokenBody, body).token);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Req() req: ApiRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.limit(req, 'login');
    const { email, password } = parseBody(loginBody, body);
    const { token, mfaRequired } = await this.auth.login(email, password);
    setSessionCookie(reply, token, this.config);
    return { mfaRequired };
  }

  @AllowMfaPending()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: ApiRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    await this.sessions.revoke(requireAuth(req).token);
    clearSessionCookie(reply, this.config);
  }

  @AllowMfaPending()
  @Post('mfa/enroll')
  @HttpCode(200)
  async mfaEnroll(@Req() req: ApiRequest) {
    const { user } = requireAuth(req);
    return this.mfa.enroll(user.id, user.email);
  }

  @AllowMfaPending()
  @Post('mfa/verify')
  @HttpCode(200)
  async mfaVerify(@Req() req: ApiRequest, @Body() body: unknown) {
    await this.limit(req, 'mfa');
    const { user, session } = requireAuth(req);
    const result = await this.mfa.verify(user.id, session.id, parseBody(mfaVerifyBody, body));
    return result.recoveryCodes ? { recoveryCodes: result.recoveryCodes } : { status: 'verified' };
  }

  @Public()
  @Post('password/reset-request')
  @HttpCode(202)
  async resetRequest(@Req() req: ApiRequest, @Body() body: unknown) {
    await this.limit(req, 'reset');
    await this.auth.requestPasswordReset(parseBody(resetRequestBody, body).email);
    return { status: 'accepted' };
  }

  @Public()
  @Post('password/reset')
  @HttpCode(204)
  async reset(@Req() req: ApiRequest, @Body() body: unknown) {
    await this.limit(req, 'reset');
    const { token, password } = parseBody(resetBody, body);
    await this.auth.resetPassword(token, password);
  }

  /** Which sign-in methods this deployment offers, for the login page (M19.4). */
  @Public()
  @Get('providers')
  providers() {
    return this.oidc.providers();
  }

  @Public()
  @Get('oidc/start')
  async oidcStart(@Res() reply: FastifyReply) {
    const { url, state } = await this.oidc.start();
    setOAuthStateCookie(reply, state, this.config);
    return reply.redirect(url, 302);
  }

  @Public()
  @Get('oidc/callback')
  async oidcCallback(@Req() req: ApiRequest, @Query() query: unknown, @Res() reply: FastifyReply) {
    const { code, state } = parseBody(googleCallbackQuery, query);
    const { token } = await this.oidc.callback(code, state, req.cookies?.[OAUTH_STATE_COOKIE]);
    clearOAuthStateCookie(reply, this.config);
    setSessionCookie(reply, token, this.config);
    return reply.redirect(`${this.config.appOrigin}/`, 302);
  }

  @Public()
  @Get('google/start')
  async googleStart(@Res() reply: FastifyReply) {
    const { url, state } = await this.google.start();
    setOAuthStateCookie(reply, state, this.config);
    return reply.redirect(url, 302);
  }

  @Public()
  @Get('google/callback')
  async googleCallback(@Req() req: ApiRequest, @Query() query: unknown, @Res() reply: FastifyReply) {
    const { code, state } = parseBody(googleCallbackQuery, query);
    const { token } = await this.google.callback(code, state, req.cookies?.[OAUTH_STATE_COOKIE]);
    clearOAuthStateCookie(reply, this.config);
    setSessionCookie(reply, token, this.config);
    return reply.redirect(`${this.config.appOrigin}/`, 302);
  }
}

@Controller('api/v1')
export class MeController {
  constructor(private readonly auth: AuthService) {}

  @AllowMfaPending()
  @Get('me')
  async me(@Req() req: ApiRequest) {
    const { user, session } = requireAuth(req);
    return { ...(await this.auth.me(user.id)), session: { mfaVerified: session.mfaVerified } };
  }
}
