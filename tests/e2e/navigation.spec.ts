import { randomUUID } from 'node:crypto';
import { expect, request, test, type APIRequestContext } from '@playwright/test';
import { BASE_URL } from './helpers/env';
import { linkPath, waitForMail } from './helpers/mailpit';
import { nowSeconds, totp } from './helpers/totp';

const PASSWORD = 'correct horse battery staple';

async function account(email: string): Promise<APIRequestContext> {
  const ctx = await request.newContext({ baseURL: BASE_URL });
  await ctx.post('/api/v1/auth/signup', { data: { email, password: PASSWORD } });
  const token = new URLSearchParams(
    linkPath(await waitForMail(email, 'Verify your email')).split('?')[1],
  ).get('token')!;
  expect((await ctx.post('/api/v1/auth/verify', { data: { token } })).status()).toBe(204);
  expect((await ctx.post('/api/v1/auth/login', { data: { email, password: PASSWORD } })).status()).toBe(200);
  return ctx;
}

test('viewer: no Settings or Audit Log in navigation; typed settings URL shows not found (Review Focus #3)', async ({
  page,
}) => {
  const ownerEmail = `owner-${randomUUID()}@example.com`;
  const viewerEmail = `viewer-${randomUUID()}@example.com`;

  const owner = await account(ownerEmail);
  const org = (await (
    await owner.post('/api/v1/organizations', { data: { name: 'Viewer Test Org', timezone: 'UTC' } })
  ).json()) as { id: string };
  const { secret } = (await (await owner.post('/api/v1/auth/mfa/enroll')).json()) as { secret: string };
  expect(
    (await owner.post('/api/v1/auth/mfa/verify', { data: { code: totp(secret, nowSeconds()) } })).status(),
  ).toBe(200);
  expect(
    (
      await owner.post(`/api/v1/organizations/${org.id}/invitations`, {
        data: { email: viewerEmail, role: 'viewer' },
      })
    ).status(),
  ).toBe(201);

  await account(viewerEmail);
  const accept = linkPath(await waitForMail(viewerEmail, 'You are invited'));

  // Browser: the invitation link sends the signed-out viewer through login and back.
  await page.goto(accept);
  await expect(page).toHaveURL(/\/login\?next=/);
  await page.getByLabel('Email').fill(viewerEmail);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(new RegExp(`/orgs/${org.id}$`));

  const nav = page.getByRole('navigation', { name: 'Viewer Test Org' });
  await expect(nav.getByRole('link', { name: 'Members & Roles' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Settings' })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Audit Log' })).toHaveCount(0);

  await page.goto(`/orgs/${org.id}/settings`);
  await expect(page.getByRole('heading', { name: 'Not found' })).toBeVisible();
});
