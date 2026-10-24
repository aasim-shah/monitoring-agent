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

/** A production host running agent 0.3.0 (the restart itself runs in agent-e2e against a real helper). */
function seedHost(orgId: string, productId: string) {
  const [env, enrollment, agent] = [randomUUID(), randomUUID(), randomUUID()];
  psql(`
    INSERT INTO environments (id, organization_id, product_id, name) VALUES ('${env}', '${orgId}', '${productId}', 'production');
    INSERT INTO agent_enrollments (id, organization_id, product_id, environment_id, token_hash, expires_at)
      VALUES ('${enrollment}', '${orgId}', '${productId}', '${env}', 'e2e-${enrollment}', now() + interval '1 hour');
    INSERT INTO agents (id, organization_id, product_id, environment_id, enrollment_id, agent_type, hostname, machine_id, os, arch, agent_version, last_heartbeat_at)
      VALUES ('${agent}', '${orgId}', '${productId}', '${env}', '${enrollment}', 'host', 'vps-1', 'm-${agent}', 'linux', 'amd64', '0.3.0', now());`);
  return { env, agent };
}

test('automations: a disabled-by-default policy is enabled, a restart is proposed with its impact, and the requester cannot approve it in production (M16)', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const email = `actions-${randomUUID()}@example.com`;
  await page.goto('/signup');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.goto(linkPath(await waitForMail(email, 'Verify your email')));
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByLabel('Organization name').fill('Ops Co');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await page.getByRole('button', { name: 'Set up authenticator app' }).click();
  const secret = (await page.getByTestId('mfa-secret').textContent())!.trim();
  await page.getByLabel('Authentication code').fill(totp(secret, nowSeconds()));
  await page.getByRole('button', { name: 'Turn on two-factor authentication' }).click();
  await page.getByRole('button', { name: 'I saved these codes' }).click();
  await page.getByRole('link', { name: /Ops Co/ }).click();
  await page.getByLabel('Product name').fill('FireMaps');
  await page.getByRole('button', { name: 'Create product' }).click();
  await page.getByRole('link', { name: /FireMaps/ }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]+\/products\/[0-9a-f-]+/);
  const [, orgId, productId] = /\/orgs\/([0-9a-f-]+)\/products\/([0-9a-f-]+)/.exec(page.url())!;
  seedHost(orgId!, productId!);
  // The product page already cached its (empty) agent list before the host was inserted.
  await page.reload();

  await page.getByRole('link', { name: 'Automations & Approvals' }).click();
  await expect(page.getByRole('heading', { name: 'Automations & Approvals' })).toBeVisible();
  // BR-16-01: disabled by default; Cloudflare waits for its connection.
  const restart = page.getByRole('row', { name: 'Restart service · production' });
  await expect(restart).toContainText('Disabled');
  await expect(page.getByRole('row', { name: 'Purge Cloudflare cache · production' })).toContainText(
    'Needs a Cloudflare connection',
  );

  await restart.getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Enabled').check();
  await page.getByLabel('Units that may be restarted').fill('firemaps-api.service');
  await expect(page.getByLabel('Allow without approval')).toBeDisabled();
  await page.getByRole('button', { name: 'Save policy' }).click();
  await expect(restart).toContainText('Enabled');
  await expect(restart).toContainText('firemaps-api.service');

  await page.getByRole('button', { name: 'Propose restart' }).click();
  await page.getByLabel('Service', { exact: true }).selectOption('firemaps-api.service');
  await page.getByLabel('Reason').fill('API stuck after deploy');
  await page.getByRole('button', { name: 'Send for approval' }).click();
  const request = page.getByRole('row', { name: /Restart firemaps-api.service on vps-1/ });
  await expect(request).toContainText('Waiting for approval');
  await expect(request).toContainText('has no known dependents in the asset graph');
  // BR-16-03: the requester cannot approve their own production action.
  await expect(request).toContainText('Waiting for another approver');
  await expect(request.getByRole('button', { name: 'Approve' })).toHaveCount(0);

  await request.getByRole('link', { name: /Restart firemaps-api.service/ }).click();
  await expect(page.getByRole('list', { name: 'Timeline' })).toContainText('Proposed');
  expect(
    psql(
      `SELECT string_agg(action, ',' ORDER BY created_at) FROM audit_logs WHERE organization_id = '${orgId}' AND action LIKE 'action%'`,
    ).trim(),
  ).toBe('action_policy.update,action.propose');
});
