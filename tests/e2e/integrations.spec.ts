import { createHmac, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { BASE_URL } from './helpers/env';
import { linkPath, waitForMail } from './helpers/mailpit';
import { nowSeconds, totp } from './helpers/totp';

const PASSWORD = 'correct horse battery staple';
const WEBHOOK_SECRET = 'whsec-e2e-0123456789abcdef';

test('Integrations: GitHub connects, repositories are scoped, and a signed deployment reaches the AI (M7 exit gate)', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const email = `int-${randomUUID()}@example.com`;
  await page.goto('/signup');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.goto(linkPath(await waitForMail(email, 'Verify your email')));
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByLabel('Organization name').fill('Ship Co');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await page.getByRole('button', { name: 'Set up authenticator app' }).click();
  const secret = (await page.getByTestId('mfa-secret').textContent())!.trim();
  await page.getByLabel('Authentication code').fill(totp(secret, nowSeconds()));
  await page.getByRole('button', { name: 'Turn on two-factor authentication' }).click();
  await page.getByRole('button', { name: 'I saved these codes' }).click();
  await page.getByRole('link', { name: /Ship Co/ }).click();
  await page.getByLabel('Product name').fill('FireMaps');
  await page.getByRole('button', { name: 'Create product' }).click();
  await page.getByRole('link', { name: /FireMaps/ }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]+\/products\/[0-9a-f-]+/);

  // Connect: the wizard names the token permissions before asking for the token.
  await page.getByRole('link', { name: 'Integrations' }).click();
  await page.getByRole('button', { name: 'Connect GitHub' }).click();
  await expect(page.getByRole('list', { name: 'Token permissions' })).toContainText('Deployments: Read-only');
  await page.getByLabel('Owner (user or organization)').fill('acme');
  await page.getByLabel('Fine-grained personal access token').fill('github_pat_e2e');
  await page.getByLabel('Webhook secret').fill(WEBHOOK_SECRET);
  await page.getByRole('button', { name: 'Save and validate' }).click();
  await page.waitForURL(/\/integrations\/[0-9a-f-]{36}$/);
  const connectionId = page.url().split('/').pop()!;
  await expect(page.getByText('connected', { exact: true })).toBeVisible({ timeout: 60_000 });

  // Discovery, then scope one repository to this product.
  await page.getByRole('button', { name: 'Discover now' }).click();
  const inventory = page.getByRole('region', { name: 'Discovered resources' });
  await expect(inventory.getByLabel('acme/shop')).toBeVisible({ timeout: 60_000 });
  await expect(inventory).toContainText('workflows');
  await inventory.getByLabel('acme/shop').check();
  await inventory.getByRole('button', { name: 'Save scope' }).click();
  await expect(page.getByText(/Scope saved/)).toBeVisible();
  await expect(inventory.getByLabel('acme/shop')).toBeChecked();
  await expect(inventory.getByLabel('acme/api')).not.toBeChecked();

  // The webhook URL is shown; a forged delivery is refused and a signed one becomes a change event.
  await expect(page.getByText(`/webhooks/github/${connectionId}`)).toBeVisible();
  const url = `${BASE_URL}/webhooks/github/${connectionId}`;
  const body = JSON.stringify({
    deployment_status: { state: 'success', created_at: new Date().toISOString(), creator: { login: 'dev1' } },
    deployment: { id: 9001, ref: 'main', environment: 'production' },
    repository: { full_name: 'acme/shop' },
  });
  const send = (signature: string, delivery: string) =>
    fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'deployment_status',
        'x-github-delivery': delivery,
        'x-hub-signature-256': signature,
      },
      body,
    });
  expect((await send('sha256=00', randomUUID())).status).toBe(401);
  const signed = await send(
    `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`,
    'e2e-delivery-1',
  );
  expect(signed.status).toBe(202);
  await page.reload();
  await expect(page.getByText('Deployed main to production (acme/shop)')).toBeVisible();
  await expect(page.getByRole('table', { name: 'Webhook deliveries' })).toContainText('e2e-delivery-1');

  // The assistant now has a deployment source.
  await page.getByRole('link', { name: 'AI Assistant' }).click();
  await page.getByLabel('Ask about this product').fill('What changed in FireMaps today?');
  await page.getByRole('button', { name: 'Ask' }).click();
  await expect(page.getByText(/Finding 1 \(confidence: medium\)/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Deployments: source not connected')).toHaveCount(0);
});
