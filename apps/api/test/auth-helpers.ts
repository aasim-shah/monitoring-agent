import { totp } from '../src/modules/identity/totp.js';
import { APP_ORIGIN, sessionCookie, uniqueEmail, uniqueIp, type TestApp } from './app-factory.js';

export const PASSWORD = 'correct horse battery staple';

const json = { 'content-type': 'application/json', origin: APP_ORIGIN };

export async function signUpAndVerify(t: TestApp, email = uniqueEmail()): Promise<string> {
  const ip = uniqueIp();
  await t.app.inject({
    method: 'POST',
    url: '/api/v1/auth/signup',
    headers: json,
    remoteAddress: ip,
    payload: { email, password: PASSWORD },
  });
  await t.app.inject({
    method: 'POST',
    url: '/api/v1/auth/verify',
    headers: json,
    payload: { token: t.mailer.lastToken(email) },
  });
  return email;
}

export async function login(t: TestApp, email: string, password = PASSWORD): Promise<string> {
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: json,
    remoteAddress: uniqueIp(),
    payload: { email, password },
  });
  if (res.statusCode !== 200) throw new Error(`login failed ${res.statusCode} ${res.body}`);
  return sessionCookie(res);
}

/** Enrolls TOTP for the logged-in user; returns the secret. */
export async function enrollMfa(t: TestApp, cookie: string): Promise<string> {
  const enroll = await t.app.inject({
    method: 'POST',
    url: '/api/v1/auth/mfa/enroll',
    headers: { ...json, cookie },
    payload: {},
  });
  const { secret } = enroll.json() as { secret: string };
  await t.app.inject({
    method: 'POST',
    url: '/api/v1/auth/mfa/verify',
    headers: { ...json, cookie },
    remoteAddress: uniqueIp(),
    payload: { code: totp(secret, Math.floor(Date.now() / 1000)) },
  });
  return secret;
}

export const headers = (cookie?: string) => (cookie ? { ...json, cookie } : json);
