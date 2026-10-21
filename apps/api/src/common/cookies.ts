import type {} from '@fastify/cookie';
import type { FastifyReply } from 'fastify';
import type { AppConfig } from '../config.js';

export const SESSION_COOKIE = 'pcp_session';
export const OAUTH_STATE_COOKIE = 'pcp_oauth_state';
const SEVEN_DAYS_SECONDS = 7 * 24 * 3600;

/** `Secure` is omitted only in private HTTP bootstrap mode (master plan D2). */
const secure = (config: AppConfig) => config.bootstrapMode !== 'private_http';

export function setSessionCookie(reply: FastifyReply, token: string, config: AppConfig) {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: secure(config),
    maxAge: SEVEN_DAYS_SECONDS,
  });
}

export function clearSessionCookie(reply: FastifyReply, config: AppConfig) {
  reply.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, sameSite: 'lax', secure: secure(config) });
}

export function setOAuthStateCookie(reply: FastifyReply, state: string, config: AppConfig) {
  reply.setCookie(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/api/v1/auth/google',
    secure: secure(config),
    maxAge: 600,
  });
}

export function clearOAuthStateCookie(reply: FastifyReply, config: AppConfig) {
  reply.clearCookie(OAUTH_STATE_COOKIE, { path: '/api/v1/auth/google', secure: secure(config) });
}
