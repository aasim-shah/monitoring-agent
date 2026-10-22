import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  APP_ORIGIN,
  createTestApp,
  sessionCookie,
  uniqueEmail,
  uniqueIp,
  type TestApp,
} from '../../../test/app-factory.js';
import { PASSWORD, headers, login, signUpAndVerify } from '../../../test/auth-helpers.js';
import { totp } from './totp.js';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t?.close();
});

const post = (url: string, payload: unknown, opts: { cookie?: string; ip?: string; origin?: string } = {}) =>
  t.app.inject({
    method: 'POST',
    url,
    headers: { ...headers(opts.cookie), ...(opts.origin ? { origin: opts.origin } : {}) },
    remoteAddress: opts.ip ?? uniqueIp(),
    payload: payload as Record<string, unknown>,
  });

const strip = (body: string) => {
  const { requestId: _r, ...rest } = JSON.parse(body) as Record<string, unknown>;
  return rest;
};

describe('sign-up and verification', () => {
  it('responds identically for new and existing emails (no enumeration)', async () => {
    const email = uniqueEmail();
    const first = await post('/api/v1/auth/signup', { email, password: PASSWORD });
    const second = await post('/api/v1/auth/signup', { email, password: PASSWORD });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(strip(second.body)).toEqual(strip(first.body));
    expect(t.mailer.to(email)).toHaveLength(2);
  });

  it('rejects a short password', async () => {
    const res = await post('/api/v1/auth/signup', { email: uniqueEmail(), password: 'short' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('validation_failed');
  });

  it('verifies with the mailed token once', async () => {
    const email = uniqueEmail();
    await post('/api/v1/auth/signup', { email, password: PASSWORD });
    const token = t.mailer.lastToken(email);
    expect((await post('/api/v1/auth/verify', { token })).statusCode).toBe(204);
    const again = await post('/api/v1/auth/verify', { token });
    expect(again.statusCode).toBe(400);
    expect(again.json().code).toBe('invalid_token');
  });
});

describe('login', () => {
  it('refuses unverified accounts', async () => {
    const email = uniqueEmail();
    await post('/api/v1/auth/signup', { email, password: PASSWORD });
    const res = await post('/api/v1/auth/login', { email, password: PASSWORD });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('email_not_verified');
  });

  it('answers wrong password and unknown email identically', async () => {
    const email = await signUpAndVerify(t);
    const wrong = await post('/api/v1/auth/login', { email, password: 'wrong password 123' });
    const unknown = await post('/api/v1/auth/login', {
      email: uniqueEmail(),
      password: 'wrong password 123',
    });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(strip(unknown.body)).toEqual(strip(wrong.body));
    expect(wrong.json().code).toBe('invalid_credentials');
  });

  it('rate limits 11 attempts per minute from one IP', async () => {
    // Fixed one-minute windows: 21 attempts always put 11 in one window, even across a boundary.
    const ip = uniqueIp();
    const statuses: number[] = [];
    let last;
    for (let i = 0; i < 21 && last?.statusCode !== 429; i++) {
      last = await post('/api/v1/auth/login', { email: uniqueEmail(), password: 'x'.repeat(12) }, { ip });
      statuses.push(last.statusCode);
    }
    expect(statuses.filter((s) => s === 401).length).toBeGreaterThanOrEqual(10);
    expect(last!.statusCode).toBe(429);
    expect(last!.json().code).toBe('rate_limited');
    expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('sets a Secure, HttpOnly, SameSite=Lax session cookie and supports logout', async () => {
    const email = await signUpAndVerify(t);
    const res = await post('/api/v1/auth/login', { email, password: PASSWORD });
    expect(res.statusCode).toBe(200);
    const raw = String(
      ([] as string[])
        .concat(res.headers['set-cookie'] as string[])
        .find((c) => c.startsWith('pcp_session=')),
    );
    expect(raw).toMatch(/HttpOnly/);
    expect(raw).toMatch(/SameSite=Lax/);
    expect(raw).toMatch(/Secure/);
    expect(raw).toMatch(/Path=\//);
    const cookie = sessionCookie(res);
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: headers(cookie) })).statusCode,
    ).toBe(200);
    expect((await post('/api/v1/auth/logout', {}, { cookie })).statusCode).toBe(204);
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: headers(cookie) })).statusCode,
    ).toBe(401);
  });

  it('rejects requests from a foreign Origin', async () => {
    const res = await post(
      '/api/v1/auth/login',
      { email: uniqueEmail(), password: PASSWORD },
      { origin: 'https://evil.example' },
    );
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('forbidden_origin');
  });

  it('requires a session for /me', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('unauthenticated');
  });
});

describe('bootstrap HTTP mode (Review Focus #4)', () => {
  it('omits Secure only when BOOTSTRAP_MODE=private_http', async () => {
    const bootstrap = await createTestApp({ env: { BOOTSTRAP_MODE: 'private_http' } });
    try {
      const email = await signUpAndVerify(bootstrap);
      const res = await bootstrap.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: headers(),
        remoteAddress: uniqueIp(),
        payload: { email, password: PASSWORD },
      });
      const raw = String(
        ([] as string[])
          .concat(res.headers['set-cookie'] as string[])
          .find((c) => c.startsWith('pcp_session=')),
      );
      expect(raw).toMatch(/HttpOnly/);
      expect(raw).not.toMatch(/Secure/);
    } finally {
      await bootstrap.close();
    }
  });
});

describe('password reset', () => {
  it('responds identically for unknown emails', async () => {
    const known = await signUpAndVerify(t);
    const a = await post('/api/v1/auth/password/reset-request', { email: known });
    const b = await post('/api/v1/auth/password/reset-request', { email: uniqueEmail() });
    expect(a.statusCode).toBe(202);
    expect(strip(b.body)).toEqual(strip(a.body));
  });

  it('resets the password and revokes existing sessions', async () => {
    const email = await signUpAndVerify(t);
    const oldCookie = await login(t, email);
    await post('/api/v1/auth/password/reset-request', { email });
    const res = await post('/api/v1/auth/password/reset', {
      token: t.mailer.lastToken(email),
      password: 'a brand new password',
    });
    expect(res.statusCode).toBe(204);
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: headers(oldCookie) })).statusCode,
    ).toBe(401);
    await expect(login(t, email, 'a brand new password')).resolves.toMatch(/^pcp_session=/);
  });
});

describe('MFA', () => {
  const now = () => Math.floor(Date.now() / 1000);

  it('enrolls TOTP, stores the secret encrypted, and returns 10 recovery codes once', async () => {
    const email = await signUpAndVerify(t);
    const cookie = await login(t, email);
    const enroll = await post('/api/v1/auth/mfa/enroll', {}, { cookie });
    expect(enroll.statusCode).toBe(200);
    const { secret, otpauthUri } = enroll.json() as { secret: string; otpauthUri: string };
    expect(otpauthUri).toContain(secret);

    const verify = await post('/api/v1/auth/mfa/verify', { code: totp(secret, now()) }, { cookie });
    expect(verify.statusCode).toBe(200);
    expect(verify.json().recoveryCodes).toHaveLength(10);

    const user = await t.prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.mfaEnabledAt).not.toBeNull();
    expect(user.mfaSecret).not.toContain(secret);
    expect(user.mfaPendingSecret).toBeNull();
  });

  it('requires a second factor on the next login; a recovery code works once', async () => {
    const email = await signUpAndVerify(t);
    const first = await login(t, email);
    const enroll = await post('/api/v1/auth/mfa/enroll', {}, { cookie: first });
    const { secret } = enroll.json() as { secret: string };
    const codes = (
      await post('/api/v1/auth/mfa/verify', { code: totp(secret, now()) }, { cookie: first })
    ).json().recoveryCodes as string[];

    const second = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: headers(),
      remoteAddress: uniqueIp(),
      payload: { email, password: PASSWORD },
    });
    expect(second.json()).toEqual({ mfaRequired: true });
    const pending = sessionCookie(second);
    const me = await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: headers(pending) });
    expect(me.json().session.mfaVerified).toBe(false);

    expect((await post('/api/v1/auth/mfa/verify', { code: '000000' }, { cookie: pending })).statusCode).toBe(
      401,
    );
    expect(
      (await post('/api/v1/auth/mfa/verify', { recoveryCode: codes[0] }, { cookie: pending })).statusCode,
    ).toBe(200);
    const after = await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: headers(pending) });
    expect(after.json().session.mfaVerified).toBe(true);

    const third = await login(t, email);
    const reuse = await post('/api/v1/auth/mfa/verify', { recoveryCode: codes[0] }, { cookie: third });
    expect(reuse.statusCode).toBe(401);
    expect(reuse.json().code).toBe('invalid_mfa_code');
  });
});

describe('origin constant', () => {
  it('tests run against the configured app origin', () => expect(APP_ORIGIN).toBe('http://localhost:8080'));
});
