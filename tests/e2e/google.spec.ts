import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { BASE_URL } from './helpers/env';
import { linkPath, waitForMail } from './helpers/mailpit';
import { nowSeconds, totp } from './helpers/totp';

const PASSWORD = 'correct horse battery staple';

test('Google: consent with partial access, scope a property and an app, and see analytics and vitals (M13b exit gate)', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const email = `goog-${randomUUID()}@example.com`;
  await page.goto('/signup');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.goto(linkPath(await waitForMail(email, 'Verify your email')));
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByLabel('Organization name').fill('Metrics Co');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await page.getByRole('button', { name: 'Set up authenticator app' }).click();
  const secret = (await page.getByTestId('mfa-secret').textContent())!.trim();
  await page.getByLabel('Authentication code').fill(totp(secret, nowSeconds()));
  await page.getByRole('button', { name: 'Turn on two-factor authentication' }).click();
  await page.getByRole('button', { name: 'I saved these codes' }).click();
  await page.getByRole('link', { name: /Metrics Co/ }).click();
  await page.getByLabel('Product name').fill('FireMaps');
  await page.getByRole('button', { name: 'Create product' }).click();
  await page.getByRole('link', { name: /FireMaps/ }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]+\/products\/[0-9a-f-]+/);

  // Before connecting: the Analytics page says Google is not connected (no zeros).
  await page.getByRole('link', { name: 'Analytics & Ads' }).click();
  await page.waitForURL(/\/analytics$/);
  await expect(page.getByText(/Google is not connected/)).toBeVisible();

  // The e2e stack has no internet: answer Google's consent screen here and send the browser back.
  let consent: URL | null = null;
  await page.route('https://accounts.google.com/**', async (route) => {
    consent = new URL(route.request().url());
    const back = new URL(`${BASE_URL}/api/v1/connections/oauth/google/callback`);
    back.searchParams.set('code', 'e2e-code');
    back.searchParams.set('state', consent.searchParams.get('state')!);
    await route.fulfill({ status: 302, headers: { location: back.toString() } });
  });
  await page.getByRole('link', { name: 'Integrations' }).click();
  await page.getByRole('button', { name: 'Connect Google' }).click();
  await expect(page.getByRole('list', { name: 'Google access requested' }).getByRole('listitem')).toHaveCount(
    11,
  );
  await page.getByRole('button', { name: 'Continue to Google' }).click();
  await page.waitForURL(/\/integrations\/[0-9a-f-]{36}\?google=connected$/);
  expect(consent!.searchParams.get('access_type')).toBe('offline');
  expect(consent!.searchParams.get('code_challenge_method')).toBe('S256');
  expect(consent!.searchParams.get('scope')).toContain('https://www.googleapis.com/auth/analytics.readonly');

  // Partial consent: Ads and BigQuery were left unticked.
  await expect(page.getByText('Google access saved.')).toBeVisible();
  await expect(page.getByText('Connected as e2e-ops@example.com')).toBeVisible();
  const services = page.getByRole('table', { name: 'Google services' });
  await expect(services.getByRole('row', { name: /GA4/ })).toContainText('Available');
  await expect(services.getByRole('row', { name: /Google Ads/ })).toContainText('Access not granted');
  await expect(page.getByRole('button', { name: 'Grant access' })).toBeVisible();
  await expect(page.getByText('connected', { exact: true })).toBeVisible({ timeout: 60_000 });

  // Discover, then scope the GA4 property, the Search Console site, and the Play app to this product.
  await page.getByRole('button', { name: 'Discover now' }).click();
  const inventory = page.getByRole('region', { name: 'Discovered resources' });
  await expect(inventory.getByLabel('Shop web')).toBeVisible({ timeout: 60_000 });
  for (const name of ['Shop web', 'shop.example', 'Shop on Play', 'Shop Android'])
    await inventory.getByLabel(name).check();
  await inventory.getByRole('button', { name: 'Save scope' }).click();
  await expect(page.getByText(/Scope saved/)).toBeVisible();

  // Saving the scope syncs now: GA4 and Search Console values reach Analytics & Ads.
  await page.getByRole('link', { name: 'Analytics & Ads' }).click();
  await page.waitForURL(/\/analytics$/);
  const tiles = page.getByRole('list', { name: 'Shop web KPIs' });
  await expect(async () => {
    await page.reload();
    await expect(tiles.getByRole('listitem', { name: 'Active users' })).not.toContainText('No data', {
      timeout: 2000,
    });
  }).toPass({ timeout: 90_000 });
  await expect(tiles.getByRole('listitem', { name: 'Sessions' })).toContainText('1,595');
  await expect(page.getByText(/Today is partial/)).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'shop.example KPIs' }).getByRole('listitem', { name: 'Search clicks' }),
  ).toContainText('42');
  await expect(page.getByText(/Google Ads: pending platform approval/)).toBeVisible();

  // Play vitals and the Firebase app on Mobile Apps & SDKs.
  await page.getByRole('link', { name: 'Mobile Apps & SDKs' }).click();
  await page.waitForURL(/\/mobile$/);
  await expect(
    page
      .getByRole('list', { name: 'Shop on Play KPIs' })
      .getByRole('listitem', { name: 'User-perceived crash rate' }),
  ).toContainText('0.87%');
  await expect(page.getByRole('region', { name: 'Firebase apps' })).toContainText('Shop Android');
  await expect(page.getByText('SDK not available yet.', { exact: false })).toBeVisible();
});
