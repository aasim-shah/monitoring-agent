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
    {
      input: sql,
    },
  ).toString();
}

test('AI assistant: a scoped question gets cited findings, evidence links, and missing sources (M14 exit gate)', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const email = `ai-${randomUUID()}@example.com`;
  await page.goto('/signup');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.goto(linkPath(await waitForMail(email, 'Verify your email')));
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByLabel('Organization name').fill('Ask Co');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await page.getByRole('button', { name: 'Set up authenticator app' }).click();
  const secret = (await page.getByTestId('mfa-secret').textContent())!.trim();
  await page.getByLabel('Authentication code').fill(totp(secret, nowSeconds()));
  await page.getByRole('button', { name: 'Turn on two-factor authentication' }).click();
  await page.getByRole('button', { name: 'I saved these codes' }).click();
  await page.getByRole('link', { name: /Ask Co/ }).click();
  await page.getByLabel('Product name').fill('FireMaps');
  await page.getByRole('button', { name: 'Create product' }).click();
  await page.getByRole('link', { name: /FireMaps/ }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]+\/products\/[0-9a-f-]+/);
  const [, orgId, productId] = /\/orgs\/([0-9a-f-]+)\/products\/([0-9a-f-]+)/.exec(page.url())!;

  // Fixtures: an incident in this product, and an asset of another organization.
  const [rule, incident, otherOrg, foreign] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  psql(`
    INSERT INTO alert_rules (id, organization_id, product_id, name, template, params, severity, updated_at)
      VALUES ('${rule}', '${orgId}', '${productId}', 'Server CPU high', 'host_cpu_high', '{}', 'warning', now());
    INSERT INTO alert_incidents (id, organization_id, product_id, rule_id, fingerprint, title, severity, summary, started_at)
      VALUES ('${incident}', '${orgId}', '${productId}', '${rule}', 'fp-ai', 'Server CPU high on vps-1', 'warning', 'CPU above 90 % on vps-1.', now() - interval '20 hours');
    INSERT INTO organizations (id, name) VALUES ('${otherOrg}', 'Other Co');
    INSERT INTO assets (id, organization_id, asset_type, name, source, identity_key) VALUES ('${foreign}', '${otherOrg}', 'host', 'other-secret-host', 'agent', 'e2e:${foreign}');
  `);

  await page.getByRole('link', { name: 'AI Assistant' }).click();
  await page.getByLabel('Ask about this product').fill('Why was FireMaps slow yesterday?');
  await page.getByRole('button', { name: 'Ask' }).click();
  await expect(page.getByText('Checked incidents')).toBeVisible();
  await expect(page.getByText(/Finding 1 \(confidence: medium\)/)).toBeVisible();
  await expect(page.getByText('Numbers checked against the evidence')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Missing evidence' })).toContainText(
    'Deployments: source not connected',
  );
  await page.getByRole('button', { name: 'Evidence E1' }).click();
  const panel = page.getByRole('region', { name: 'Evidence E1' });
  await expect(panel).toContainText('Incidents');
  await expect(panel.getByRole('link', { name: 'Incident: Server CPU high on vps-1' })).toHaveAttribute(
    'href',
    `/orgs/${orgId}/products/${productId}/incidents/${incident}`,
  );

  // Another organization's asset is not available, and its name never appears (TC-14-01).
  await page.getByRole('button', { name: 'New conversation' }).click();
  await page.getByLabel('Ask about this product').fill(`Tell me about asset ${foreign}`);
  await page.getByRole('button', { name: 'Ask' }).click();
  await expect(page.getByText('Could not check asset details')).toBeVisible();
  await expect(page.getByText('other-secret-host')).toHaveCount(0);
  expect(
    psql(
      `SELECT count(*) FROM audit_logs WHERE organization_id = '${orgId}' AND action = 'ai.tool_denied'`,
    ).trim(),
  ).toBe('1');

  // Incidents offer Ask AI; turning AI off hides it.
  await page.goto(`/orgs/${orgId}/products/${productId}/incidents/${incident}`);
  await expect(page.getByRole('link', { name: 'Ask AI' })).toBeVisible();
  await page.goto(`/orgs/${orgId}/settings`);
  await page.getByRole('switch', { name: 'AI assistant' }).click();
  await expect(page.getByText(/Off: AI buttons are hidden/)).toBeVisible();
  await page.goto(`/orgs/${orgId}/products/${productId}/incidents/${incident}`);
  await expect(page.getByRole('heading', { name: 'Server CPU high on vps-1' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Ask AI' })).toHaveCount(0);
});
