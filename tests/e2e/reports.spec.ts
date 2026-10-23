import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { linkPath, waitForMail } from './helpers/mailpit';
import { nowSeconds, totp } from './helpers/totp';

const PASSWORD = 'correct horse battery staple';

test('reports: a daily schedule runs, persists, and delivers with missing-data warnings (M15 exit gate)', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const email = `reports-${randomUUID()}@example.com`;
  const ops = `ops-${randomUUID()}@example.com`;
  await page.goto('/signup');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.goto(linkPath(await waitForMail(email, 'Verify your email')));
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByLabel('Organization name').fill('Report Co');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await page.getByRole('button', { name: 'Set up authenticator app' }).click();
  const secret = (await page.getByTestId('mfa-secret').textContent())!.trim();
  await page.getByLabel('Authentication code').fill(totp(secret, nowSeconds()));
  await page.getByRole('button', { name: 'Turn on two-factor authentication' }).click();
  await page.getByRole('button', { name: 'I saved these codes' }).click();
  await page.getByRole('link', { name: /Report Co/ }).click();
  await page.getByLabel('Product name').fill('Shop');
  await page.getByRole('button', { name: 'Create product' }).click();
  await page.getByRole('link', { name: /Shop/ }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]+\/products\/[0-9a-f-]+/);
  const [, orgId, productId] = /\/orgs\/([0-9a-f-]+)\/products\/([0-9a-f-]+)/.exec(page.url())!;

  // An email channel; the report goes there and to one direct recipient.
  await page.goto(`/orgs/${orgId}/settings/notifications`);
  await page.getByRole('button', { name: 'Add channel' }).click();
  await page.getByLabel('Name').fill('Ops email');
  await page.getByLabel('Recipients').fill(ops);
  await page.getByRole('button', { name: 'Save channel' }).click();
  await expect(page.getByRole('row', { name: /Ops email/ })).toBeVisible();

  // UC-15-01: a daily schedule at 08:00 Asia/Karachi with the next run shown in UTC.
  await page.goto(`/orgs/${orgId}/products/${productId}`);
  await page.getByRole('link', { name: 'Reports & Schedules' }).click();
  await expect(page.getByRole('heading', { name: 'Reports & Schedules' })).toBeVisible();
  await page.getByRole('button', { name: 'Add schedule' }).click();
  await page.getByLabel('Name').fill('Daily summary');
  await page.getByLabel('Timezone').selectOption('Asia/Karachi');
  await expect(page.getByRole('status')).toContainText(/Next run: .* 08:00 \(03:00 UTC\) · covers 24 h/);
  await page.getByLabel('Ops email').check();
  await page.getByRole('button', { name: 'Save schedule' }).click();
  const schedule = page.getByRole('row', { name: /Daily summary/ });
  await expect(schedule).toContainText('08:00 Asia/Karachi');
  await expect(schedule).toContainText('Ops email');

  // UC-15-02/03: run now; the worker generates, persists, and delivers.
  await schedule.getByRole('button', { name: 'Run now' }).click();
  const v1 = page.getByRole('row', { name: / · v1/ });
  await expect(async () => {
    await page.reload();
    await expect(v1).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 120_000, intervals: [3000] });
  await expect(v1).toContainText('Verified summary');
  const localDate = (await v1.getAttribute('aria-label'))!.split(' · ')[0]!;

  const mail = await waitForMail(ops, `Daily report — Shop — ${localDate}`, 60_000);
  expect(mail).toContain('Data coverage and missing sources');
  // Mail bodies travel with CRLF line endings.
  expect(mail).toMatch(/User analytics\r?\nNo data: Google Analytics not connected \(M13b\)/);

  // UC-15-04/06: the report view with sections, coverage, and the delivery log.
  await v1.getByRole('link', { name: 'Open' }).click();
  await expect(page.getByRole('heading', { name: `Daily report — ${localDate} · v1` })).toBeVisible();
  await expect(page.getByText('Verified against the data')).toBeVisible();
  await expect(page.getByRole('region', { name: 'User analytics' })).toContainText(
    'No data: Google Analytics not connected (M13b)',
  );
  await expect(page.getByRole('region', { name: 'Data coverage and missing sources' })).toContainText(
    'Host metrics: missing',
  );
  await expect(page.getByRole('region', { name: 'Product health' })).toContainText(
    'Open now: 0 (critical: 0)',
  );
  await expect(page.getByRole('row', { name: 'Ops email' })).toContainText('Sent');

  // UC-15-09: regenerating adds version 2 and keeps version 1.
  await page.getByRole('button', { name: 'Regenerate' }).click();
  await expect(page.getByText('A new version is being generated')).toBeVisible();
  await page.goto(`/orgs/${orgId}/products/${productId}/reports`);
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole('row', { name: `${localDate} · v2` })).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 120_000, intervals: [3000] });
  await expect(page.getByRole('row', { name: `${localDate} · v1` })).toBeVisible();
});
