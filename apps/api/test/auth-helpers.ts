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
    payload: { code: totp(secret, Math.floor(t.now().getTime() / 1000)) },
  });
  return secret;
}

export const headers = (cookie?: string) => (cookie ? { ...json, cookie } : json);

export interface Owner {
  email: string;
  cookie: string;
  orgId: string;
}

/** Signs up, creates an organization, and enrolls MFA (owners must). */
export async function ownerWithOrg(t: TestApp, name = 'Example Company'): Promise<Owner> {
  const email = await signUpAndVerify(t);
  const cookie = await login(t, email);
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/v1/organizations',
    headers: headers(cookie),
    payload: { name, timezone: 'Europe/Berlin' },
  });
  if (res.statusCode !== 201) throw new Error(`create org failed ${res.statusCode} ${res.body}`);
  await enrollMfa(t, cookie);
  return { email, cookie, orgId: (res.json() as { id: string }).id };
}

export async function createProduct(t: TestApp, owner: Owner, name = 'FireMaps'): Promise<string> {
  const res = await t.app.inject({
    method: 'POST',
    url: `/api/v1/organizations/${owner.orgId}/products`,
    headers: headers(owner.cookie),
    payload: { name, domains: ['firemaps.example.com'], repositories: ['example/firemaps-api'] },
  });
  if (res.statusCode !== 201) throw new Error(`create product failed ${res.statusCode} ${res.body}`);
  return (res.json() as { id: string }).id;
}
