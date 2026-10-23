import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { PROJECT } from './helpers/env';
import { linkPath, waitForMail } from './helpers/mailpit';
import { nowSeconds, totp } from './helpers/totp';

const PASSWORD = 'correct horse battery staple';

/** Runs SQL as the database superuser inside the e2e stack (fixture seeding only). */
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

/** A FireMaps-like graph: website → host → Redis/PostgreSQL, plus one weak name-only edge. */
function seedGraph(orgId: string, productId: string) {
  const id = () => randomUUID();
  const [site, host, redis, pg] = [id(), id(), id(), id()];
  const asset = (a: string, type: string, name: string) =>
    `INSERT INTO assets (id, organization_id, asset_type, name, source, identity_key, lifecycle)
     VALUES ('${a}', '${orgId}', '${type}', '${name}', 'agent', 'e2e:${a}', 'active');
     INSERT INTO product_assets (organization_id, product_id, asset_id) VALUES ('${orgId}', '${productId}', '${a}');`;
  const edge = (s: string, t: string, type: string, v: string, c: number, kind: string) => {
    const e = id();
    return `INSERT INTO asset_relationships (id, organization_id, source_asset_id, target_asset_id, relationship_type, confidence, verification, rule_id, updated_at)
            VALUES ('${e}', '${orgId}', '${s}', '${t}', '${type}', ${c}, '${v}', 'e2e', now());
            INSERT INTO relationship_evidence (id, organization_id, relationship_id, kind) VALUES ('${id()}', '${orgId}', '${e}', '${kind}');`;
  };
  psql(
    [
      asset(site, 'website', 'firemaps.example'),
      asset(host, 'host', 'vps-1'),
      asset(redis, 'service', 'Redis'),
      asset(pg, 'service', 'PostgreSQL'),
      edge(host, redis, 'HOSTS', 'verified', 0.95, 'direct'),
      edge(host, pg, 'HOSTS', 'verified', 0.95, 'direct'),
      edge(site, host, 'ROUTES_TO', 'proposed', 0.8, 'ip_match'),
      edge(redis, pg, 'CONNECTS_TO', 'proposed', 0.3, 'name'),
    ].join('\n'),
  );
}

test('assets: review queue confirms and rejects; coverage matches the fixture (M9 exit gate)', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const email = `assets-${randomUUID()}@example.com`;
  await page.goto('/signup');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.goto(linkPath(await waitForMail(email, 'Verify your email')));
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByLabel('Organization name').fill('Graph Co');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await page.getByRole('button', { name: 'Set up authenticator app' }).click();
  const secret = (await page.getByTestId('mfa-secret').textContent())!.trim();
  await page.getByLabel('Authentication code').fill(totp(secret, nowSeconds()));
  await page.getByRole('button', { name: 'Turn on two-factor authentication' }).click();
  await page.getByRole('button', { name: 'I saved these codes' }).click();
  await page.getByRole('link', { name: /Graph Co/ }).click();
  await page.getByLabel('Product name').fill('FireMaps');
  await page.getByRole('button', { name: 'Create product' }).click();
  await page.getByRole('link', { name: /FireMaps/ }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]+\/products\/[0-9a-f-]+/);
  const [, orgId, productId] = /\/orgs\/([0-9a-f-]+)\/products\/([0-9a-f-]+)/.exec(page.url())!;
  seedGraph(orgId!, productId!);

  await page.getByRole('link', { name: 'Assets' }).click();
  await expect(page.getByRole('link', { name: 'vps-1' })).toBeVisible();

  await page.getByRole('tab', { name: /Review/ }).click();
  const route = page.getByRole('listitem').filter({ hasText: 'firemaps.example → vps-1' });
  await route.getByRole('button', { name: 'Confirm' }).click();
  await expect(route).toHaveCount(0);
  const weak = page.getByRole('listitem').filter({ hasText: 'Redis → PostgreSQL' });
  await weak.getByRole('button', { name: 'Reject' }).click();
  await expect(page.getByText(/Nothing to review/)).toBeVisible();

  await page.getByRole('tab', { name: 'Topology' }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(4);
  await expect(page.locator('.react-flow__edge')).toHaveCount(3); // the rejected edge is gone

  await page.getByRole('tab', { name: 'Coverage' }).click();
  // The number sits next to its label inside the same card.
  const card = (label: string) =>
    page.getByText(label, { exact: true }).locator('xpath=..').locator('p.text-2xl');
  await expect(card('Assets')).toHaveText('4');
  await expect(card('Verified relationships')).toHaveText('3');
  await expect(card('To review')).toHaveText('0');

  // The confirmation is audited.
  expect(
    psql(
      `SELECT count(*) FROM audit_logs WHERE organization_id = '${orgId}' AND action IN ('relationship.verified', 'relationship.rejected')`,
    ).trim(),
  ).toBe('2');
});
