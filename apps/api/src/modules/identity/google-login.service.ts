import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { PrismaClient } from '@pcp/database';
import { ApiException } from '../../common/errors.js';
import type { AppConfig, GoogleConfig } from '../../config.js';
import { APP_CONFIG, CLOCK, PRISMA, REDIS } from '../../tokens.js';
import { SessionService } from './session.service.js';
import { randomToken } from './tokens.js';

export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const STATE_TTL_SECONDS = 600;

/** HTTP dependencies, replaceable in tests. */
export interface GoogleHttp {
  fetch: typeof fetch;
  jwks: JWTVerifyGetKey;
}
export const GOOGLE_HTTP = Symbol('GOOGLE_HTTP');
export const defaultGoogleHttp = (): GoogleHttp => ({
  fetch: (...args) => fetch(...args),
  jwks: createRemoteJWKSet(new URL(GOOGLE_JWKS_URL)),
});

const notConfigured = () =>
  new ApiException(404, 'google_login_not_configured', 'Google sign-in is not configured');

/** "Sign in with Google": identity only (openid email profile); never data access (spec §7.2, ADR 0015). */
@Injectable()
export class GoogleLoginService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(GOOGLE_HTTP) private readonly http: GoogleHttp,
    @Inject(CLOCK) private readonly now: () => Date,
    private readonly sessions: SessionService,
  ) {}

  private get google(): GoogleConfig {
    if (!this.config.google) throw notConfigured();
    return this.config.google;
  }

  async start(): Promise<{ url: string; state: string }> {
    const google = this.google;
    const state = randomToken();
    const verifier = randomToken();
    const nonce = randomToken();
    await this.redis.set(
      `oauth:google:${state}`,
      JSON.stringify({ verifier, nonce }),
      'EX',
      STATE_TTL_SECONDS,
    );
    const url = new URL(GOOGLE_AUTHORIZE_URL);
    url.search = new URLSearchParams({
      client_id: google.clientId,
      redirect_uri: google.redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    }).toString();
    return { url: url.toString(), state };
  }

  async callback(code: string, state: string, cookieState: string | undefined): Promise<{ token: string }> {
    const google = this.google;
    const stored = await this.redis.getdel(`oauth:google:${state}`);
    if (!stored || !cookieState || cookieState !== state) {
      throw new ApiException(400, 'invalid_state', 'Sign-in session expired; start again');
    }
    const { verifier, nonce } = JSON.parse(stored) as { verifier: string; nonce: string };

    const res = await this.http.fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: google.clientId,
        client_secret: google.clientSecret,
        redirect_uri: google.redirectUri,
        grant_type: 'authorization_code',
        code_verifier: verifier,
      }),
    });
    if (!res.ok) throw new ApiException(502, 'google_token_exchange_failed', 'Google sign-in failed');
    const { id_token: idToken } = (await res.json()) as { id_token?: string };
    if (!idToken) throw new ApiException(502, 'google_token_exchange_failed', 'Google sign-in failed');

    let claims;
    try {
      ({ payload: claims } = await jwtVerify(idToken, this.http.jwks, {
        issuer: GOOGLE_ISSUERS,
        audience: google.clientId,
        currentDate: this.now(),
      }));
    } catch {
      throw new ApiException(401, 'invalid_id_token', 'Google sign-in failed');
    }
    if (claims.nonce !== nonce || typeof claims.sub !== 'string' || typeof claims.email !== 'string') {
      throw new ApiException(401, 'invalid_id_token', 'Google sign-in failed');
    }
    if (claims.email_verified !== true) {
      throw new ApiException(403, 'google_email_unverified', 'Your Google email address is not verified');
    }

    const email = claims.email.toLowerCase();
    const user =
      (await this.prisma.user.findUnique({ where: { googleSub: claims.sub } })) ??
      (await this.prisma.user.upsert({
        where: { email },
        update: { googleSub: claims.sub },
        create: { email, googleSub: claims.sub, emailVerifiedAt: this.now() },
      }));
    if (!user.emailVerifiedAt) {
      await this.prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: this.now() } });
    }
    const { token } = await this.sessions.create(user.id, { mfaVerified: !user.mfaEnabledAt });
    return { token };
  }
}
