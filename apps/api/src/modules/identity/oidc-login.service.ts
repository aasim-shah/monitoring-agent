import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { PrismaClient } from '@pcp/database';
import { ApiException } from '../../common/errors.js';
import type { AppConfig, OidcConfig } from '../../config.js';
import { APP_CONFIG, CLOCK, PRISMA, REDIS } from '../../tokens.js';
import { SessionService } from './session.service.js';
import { randomToken } from './tokens.js';

const STATE_TTL_SECONDS = 600;
const DISCOVERY_TTL_MS = 3_600_000;

interface Discovery {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwks: JWTVerifyGetKey;
  fetchedAt: number;
}

const notConfigured = () => new ApiException(404, 'oidc_not_configured', 'Single sign-on is not configured');
const failed = () => new ApiException(401, 'invalid_id_token', 'Single sign-on failed');

/**
 * Sign-in with the customer's own OpenID Provider (M19.4, self-hosted): discovery, authorization
 * code with PKCE and nonce, ID token verified against the provider's JWKS. Identity only.
 */
@Injectable()
export class OidcLoginService {
  private discovery: Discovery | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(CLOCK) private readonly now: () => Date,
    private readonly sessions: SessionService,
  ) {}

  private get oidc(): OidcConfig {
    if (!this.config.oidc) throw notConfigured();
    return this.config.oidc;
  }

  private async discover(): Promise<Discovery> {
    if (this.discovery && Date.now() - this.discovery.fetchedAt < DISCOVERY_TTL_MS) return this.discovery;
    const issuer = this.oidc.issuer;
    let doc: { issuer?: string; authorization_endpoint?: string; token_endpoint?: string; jwks_uri?: string };
    try {
      const res = await fetch(`${issuer}/.well-known/openid-configuration`, {
        signal: AbortSignal.timeout(10_000),
      });
      doc = (await res.json()) as typeof doc;
    } catch {
      throw new ApiException(502, 'oidc_discovery_failed', 'The identity provider did not answer');
    }
    if (
      doc.issuer?.replace(/\/+$/, '') !== issuer ||
      !doc.authorization_endpoint ||
      !doc.token_endpoint ||
      !doc.jwks_uri
    )
      throw new ApiException(
        502,
        'oidc_discovery_failed',
        'The identity provider configuration is not valid',
      );
    this.discovery = {
      authorizationEndpoint: doc.authorization_endpoint,
      tokenEndpoint: doc.token_endpoint,
      jwks: createRemoteJWKSet(new URL(doc.jwks_uri)),
      fetchedAt: Date.now(),
    };
    return this.discovery;
  }

  providers() {
    return {
      google: !!this.config.google,
      oidc: this.config.oidc
        ? { name: this.config.oidc.displayName, startUrl: '/api/v1/auth/oidc/start' }
        : null,
    };
  }

  async start(): Promise<{ url: string; state: string }> {
    const oidc = this.oidc;
    const d = await this.discover();
    const state = randomToken();
    const verifier = randomToken();
    const nonce = randomToken();
    await this.redis.set(`oauth:oidc:${state}`, JSON.stringify({ verifier, nonce }), 'EX', STATE_TTL_SECONDS);
    const url = new URL(d.authorizationEndpoint);
    url.search = new URLSearchParams({
      client_id: oidc.clientId,
      redirect_uri: oidc.redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString();
    return { url: url.toString(), state };
  }

  async callback(code: string, state: string, cookieState: string | undefined): Promise<{ token: string }> {
    const oidc = this.oidc;
    const stored = await this.redis.getdel(`oauth:oidc:${state}`);
    if (!stored || !cookieState || cookieState !== state)
      throw new ApiException(400, 'invalid_state', 'Sign-in session expired; start again');
    const { verifier, nonce } = JSON.parse(stored) as { verifier: string; nonce: string };
    const d = await this.discover();
    const res = await fetch(d.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: oidc.clientId,
        client_secret: oidc.clientSecret,
        redirect_uri: oidc.redirectUri,
        grant_type: 'authorization_code',
        code_verifier: verifier,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new ApiException(502, 'oidc_token_exchange_failed', 'Single sign-on failed');
    const { id_token: idToken } = (await res.json()) as { id_token?: string };
    if (!idToken) throw new ApiException(502, 'oidc_token_exchange_failed', 'Single sign-on failed');
    let claims;
    try {
      ({ payload: claims } = await jwtVerify(idToken, d.jwks, {
        issuer: oidc.issuer,
        audience: oidc.clientId,
        currentDate: this.now(),
      }));
    } catch {
      throw failed();
    }
    if (claims.nonce !== nonce || typeof claims.sub !== 'string' || typeof claims.email !== 'string')
      throw failed();
    if (claims.email_verified !== true)
      throw new ApiException(
        403,
        'oidc_email_unverified',
        'Your email address is not verified by the identity provider',
      );
    const subject = `${oidc.issuer}#${claims.sub}`;
    const user =
      (await this.prisma.user.findUnique({ where: { oidcSubject: subject } })) ??
      (await this.linkOrCreate(claims.email.toLowerCase(), subject));
    const { token } = await this.sessions.create(user.id, { mfaVerified: !user.mfaEnabledAt });
    return { token };
  }

  /** As Google sign-in: an unverified account's password is discarded before the provider proves the email. */
  private async linkOrCreate(email: string, oidcSubject: string) {
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (!existing)
      return this.prisma.user.create({ data: { email, oidcSubject, emailVerifiedAt: this.now() } });
    if (existing.emailVerifiedAt)
      return this.prisma.user.update({ where: { id: existing.id }, data: { oidcSubject } });
    await this.sessions.revokeAllForUser(existing.id);
    return this.prisma.user.update({
      where: { id: existing.id },
      data: { oidcSubject, emailVerifiedAt: this.now(), passwordHash: null },
    });
  }
}
