import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { PROJECT } from './helpers/env';
import { linkPath, waitForMail } from './helpers/mailpit';
import { nowSeconds, totp } from './helpers/totp';

const PASSWORD = 'correct horse battery staple';

function psql(sql: string): string {
  return execFileSync(
    'docker',
    [
      'exec',
      '-i',
      `${PROJECT}-postgres-1`,
      'psql',
      '-U',
      'postgres',
      '-d',
      'pcp',
      '-tA',
      '-v',
      'ON_ERROR_STOP=1',
    ],
    { input: sql },
  ).toString();
}

/**
 * A verified monitor on the stack's own web container, probed every 30 s. The API refuses private
 * targets (that is the SSRF guard), and e2e has no DNS TXT record, so the row is seeded here; the
 * worker reaches web:3001 only because the e2e override allowlists it.
 */
function seedMonitor(orgId: string, productId: string, path: string) {
  const id = randomUUID();
  psql(`
    INSERT INTO website_monitors (id, organization_id, product_id, url, host, interval_seconds, verify_token, status, verified_at, updated_at)
    VALUES ('${id}', '${orgId}', '${productId}', 'http://web:3001${path}', 'web', 30, 'e2e', 'active', now(), now());
    INSERT INTO job_definitions (organization_id, kind, entity_id, every_seconds)
    VALUES ('${orgId}', 'website-probe', '${id}', 30);`);
  return `http://web:3001${path}`;
}

test('websites: the SSRF guard refuses a private URL; probes show up and down, and a down site opens an incident (M13a exit gate)', async ({
  page,
}) => {
  test.setTimeout(480_000);
  const email = `websites-${randomUUID()}@example.com`;
  await page.goto('/signup');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.goto(linkPath(await waitForMail(email, 'Verify your email')));
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByLabel('Organization name').fill('Web Co');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await page.getByRole('button', { name: 'Set up authenticator app' }).click();
  const secret = (await page.getByTestId('mfa-secret').textContent())!.trim();
  await page.getByLabel('Authentication code').fill(totp(secret, nowSeconds()));
  await page.getByRole('button', { name: 'Turn on two-factor authentication' }).click();
  await page.getByRole('button', { name: 'I saved these codes' }).click();
  await page.getByRole('link', { name: /Web Co/ }).click();
  await page.getByLabel('Product name').fill('Shop');
  await page.getByRole('button', { name: 'Create product' }).click();
  await page.getByRole('link', { name: /Shop/ }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]+\/products\/[0-9a-f-]+/);
  const [, orgId, productId] = /\/orgs\/([0-9a-f-]+)\/products\/([0-9a-f-]+)/.exec(page.url())!;

  // The recommended rules include "Website down" (2 failed checks in a row).
  await page.goto(`/orgs/${orgId}/products/${productId}/alert-rules`);
  await page.getByRole('button', { name: 'Add recommended rules' }).click();
  await expect(page.getByRole('row', { name: /Website down/ })).toBeVisible();

  // Review Focus #1: a URL that resolves to a private address is refused at creation.
  await page.getByRole('link', { name: 'Websites & APIs' }).click();
  await expect(page.getByRole('heading', { name: 'Websites & APIs' })).toBeVisible();
  await page.getByRole('button', { name: 'Add website' }).click();
  await page.getByLabel('URL').fill('http://web:3001/');
  await page.getByRole('button', { name: 'Start monitoring' }).click();
  await expect(page.getByRole('dialog')).toContainText(/is a private address/);
  await page.getByRole('button', { name: 'Close' }).first().click();

  const upUrl = seedMonitor(orgId!, productId!, '/login');
  const downUrl = seedMonitor(orgId!, productId!, '/_next/static/e2e-missing.js');
  await page.reload();
  const up = page.getByRole('row', { name: upUrl });
  const down = page.getByRole('row', { name: downUrl });
  // The worker picks up the schedules on its next reconcile, then probes every 30 s.
  await expect(up).toContainText('Up', { timeout: 240_000 });
  await expect(up).toContainText(/\d+ ms|\d+(\.\d+)? s/);
  await expect(up).toContainText('200');
  await expect(down).toContainText('Down', { timeout: 120_000 });
  await expect(down).toContainText('404');

  // Response-time chart for the selected monitor, from real samples in VictoriaMetrics.
  await up.getByRole('button', { name: upUrl }).click();
  const charts = page.getByRole('region', { name: 'Charts' });
  await expect(charts.getByText('Response time')).toBeVisible();
  await expect(charts.getByText('Uptime')).toBeVisible();

  // Two failures in a row open one incident; the healthy site opens none.
  await page.goto(`/orgs/${orgId}/products/${productId}/incidents`);
  const incident = page.getByRole('row', { name: /Website down on web/ });
  await expect(async () => {
    await page.reload();
    await expect(incident).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 240_000, intervals: [10_000] });
  await expect(incident).toHaveCount(1);
  expect(
    psql(
      `SELECT count(*) FROM alert_incidents WHERE organization_id = '${orgId}' AND labels->>'url' = '${upUrl}'`,
    ).trim(),
  ).toBe('0');
});
