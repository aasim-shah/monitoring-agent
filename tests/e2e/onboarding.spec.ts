import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { linkPath, waitForMail } from './helpers/mailpit';
import { nowSeconds, totp } from './helpers/totp';

const PASSWORD = 'correct horse battery staple';

test('onboarding: sign up → MFA → organization → FireMaps → environments → invite → audit', async ({
  page,
}) => {
  const email = `owner-${randomUUID()}@example.com`;
  const invitee = `member-${randomUUID()}@example.com`;

  // Sign up and verify email.
  await page.goto('/signup');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText(`Check ${email}`)).toBeVisible();
  await page.goto(linkPath(await waitForMail(email, 'Verify your email')));
  await expect(page.getByText('Your email is verified.')).toBeVisible();

  // Sign in.
  await page.getByRole('link', { name: 'Sign in' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/orgs$/);

  // Create the organization; owners are sent to MFA setup (Review Focus #2).
  await page.getByLabel('Organization name').fill('Example Company');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page).toHaveURL(/\/mfa/);
  await page.getByRole('button', { name: 'Set up authenticator app' }).click();
  const secret = (await page.getByTestId('mfa-secret').textContent())!.trim();
  await page.getByLabel('Authentication code').fill(totp(secret, nowSeconds()));
  await page.getByRole('button', { name: 'Turn on two-factor authentication' }).click();
  await expect(page.getByTestId('recovery-codes').locator('li')).toHaveCount(10);
  await page.getByRole('button', { name: 'I saved these codes' }).click();

  // Open the organization and create FireMaps.
  await page.getByRole('link', { name: /Example Company/ }).click();
  await expect(page.getByRole('heading', { name: 'Products' })).toBeVisible();
  await page.getByLabel('Product name').fill('FireMaps');
  await page.getByLabel('Domains').fill('firemaps.example.com');
  await page.getByLabel('Repositories').fill('example/firemaps-api');
  await page.getByRole('button', { name: 'Create product' }).click();
  await page.getByRole('link', { name: /FireMaps/ }).click();
  await expect(page.getByRole('heading', { name: 'FireMaps' })).toBeVisible();

  // Environments.
  for (const name of ['Production', 'Staging']) {
    await page.getByLabel('New environment').fill(name);
    await page.getByRole('button', { name: 'Add environment' }).click();
    await expect(page.getByRole('list', { name: 'Environments' }).getByText(name)).toBeVisible();
  }

  // Invite a member.
  await page.getByRole('link', { name: 'Members & Roles' }).click();
  await page.getByLabel('Email').fill(invitee);
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByText(`Invitation sent to ${invitee}.`)).toBeVisible();
  expect(linkPath(await waitForMail(invitee, 'You are invited'))).toMatch(/^\/invitations\/accept\?token=/);

  // Audit log records the journey.
  await page
    .getByRole('navigation', { name: 'Example Company' })
    .getByRole('link', { name: 'Audit Log' })
    .click();
  for (const action of [
    'organization.created',
    'product.created',
    'environment.created',
    'invitation.created',
  ]) {
    await expect(page.getByRole('cell', { name: action }).first()).toBeVisible();
  }
});
