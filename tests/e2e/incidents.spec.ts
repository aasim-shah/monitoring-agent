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

/** Writes samples into VictoriaMetrics inside the stack, labelled as the ingest gateway would. */
function importCpu(labels: string, idle: number) {
  const now = Date.now();
  const lines = [0, 15, 30]
    .map((s) => `system_cpu_utilization_ratio{${labels},state="idle",cpu="cpu0"} ${idle} ${now - s * 1000}`)
    .join('\n');
  execFileSync('docker', [
    'exec',
    `${PROJECT}-victoriametrics-1`,
    'wget',
    '-q',
    '-O',
    '/dev/null',
    `--post-data=${lines}\n`,
    'http://127.0.0.1:8428/api/v1/import/prometheus',
  ]);
}

/** A host asset for the alert's agent and two dependents (Scenario B step 3: the graph links). */
function seedHost(orgId: string, productId: string, agentId: string) {
  const [host, api, site] = [randomUUID(), randomUUID(), randomUUID()];
  const asset = (a: string, type: string, name: string, key: string) =>
    `INSERT INTO assets (id, organization_id, asset_type, name, source, identity_key, lifecycle)
     VALUES ('${a}', '${orgId}', '${type}', '${name}', 'agent', '${key}', 'active');
     INSERT INTO product_assets (organization_id, product_id, asset_id) VALUES ('${orgId}', '${productId}', '${a}');`;
  const edge = (s: string, t: string, type: string) =>
    `INSERT INTO asset_relationships (id, organization_id, source_asset_id, target_asset_id, relationship_type, confidence, verification, rule_id, updated_at)
     VALUES ('${randomUUID()}', '${orgId}', '${s}', '${t}', '${type}', 0.95, 'verified', 'e2e', now());`;
  psql(
    [
      asset(host, 'host', 'vps-1', `agent:${agentId}`),
      asset(api, 'service', 'Orders API', `e2e:${api}`),
      asset(site, 'website', 'firemaps.example', `e2e:${site}`),
      edge(host, api, 'HOSTS'),
      edge(site, api, 'DEPENDS_ON'),
    ].join('\n'),
  );
}

test('incidents: a real CPU condition opens an incident, emails, and is acknowledged and resolved (M12 exit gate)', async ({
  page,
}) => {
  test.setTimeout(480_000);
  const email = `incidents-${randomUUID()}@example.com`;
  const oncall = `oncall-${randomUUID()}@example.com`;
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
  const agentId = randomUUID();
  seedHost(orgId!, productId!, agentId);

  // An email channel for the organization.
  await page.goto(`/orgs/${orgId}/settings/notifications`);
  await page.getByRole('button', { name: 'Add channel' }).click();
  await page.getByLabel('Name').fill('On call');
  await page.getByLabel('Recipients').fill(oncall);
  await page.getByRole('button', { name: 'Save channel' }).click();
  await expect(page.getByRole('row', { name: /On call/ })).toBeVisible();

  // A CPU rule that fires after one minute above 50 %.
  await page.goto(`/orgs/${orgId}/products/${productId}/alert-rules`);
  await page.getByRole('button', { name: 'Add rule' }).click();
  await page.getByLabel('Above (%)').fill('50');
  await page.getByLabel('For at least (min)').fill('1');
  await page.getByRole('button', { name: 'Save rule' }).click();
  await expect(page.getByRole('row', { name: /Server CPU high/ })).toContainText('Above 50 %');

  // Scenario B step 1: the condition is real data in VictoriaMetrics, kept fresh while vmalert evaluates.
  const labels = `tenant_id="${orgId}",product_id="${productId}",agent_id="${agentId}"`;
  importCpu(labels, 0.03);
  const keepHot = setInterval(() => importCpu(labels, 0.03), 15_000);
  try {
    // Step 2: vmalert → receiver → tenant-scoped incident.
    await page.goto(`/orgs/${orgId}/products/${productId}/incidents`);
    await expect(page.getByRole('heading', { name: 'Incidents' })).toBeVisible();
    const row = page.getByRole('row', { name: /Server CPU high on vps-1/ });
    await expect(async () => {
      await page.reload();
      await expect(row).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 300_000, intervals: [10_000] });
    await expect(row).toContainText('Open');

    // Notification by email (worker → Mailpit).
    await waitForMail(oncall, 'Server CPU high on vps-1 — opened', 120_000);

    // Steps 3 and 6: graph links, blast radius, and source links.
    await row.getByRole('link').click();
    await expect(page.getByText(/Correlated with 2 assets/)).toBeVisible();
    const blast = page.getByRole('table', { name: 'Blast radius' });
    await expect(blast.getByRole('row', { name: /Orders API/ })).toContainText('Potential');
    await expect(blast.getByRole('row', { name: /firemaps.example/ })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Asset vps-1' })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Timeline' })).toContainText('Alert fired');

    await page.getByRole('button', { name: 'Acknowledge' }).click();
    await expect(page.getByText('Acknowledged', { exact: true }).first()).toBeVisible();
    await page.getByLabel('Resolution note').fill('Scaled the worker pool');
    await page.getByRole('button', { name: 'Resolve' }).click();
    await expect(page.getByText(/Resolution: Scaled the worker pool/)).toBeVisible();
  } finally {
    clearInterval(keepHot);
  }

  expect(
    psql(
      `SELECT string_agg(action, ',' ORDER BY created_at) FROM audit_logs WHERE organization_id = '${orgId}' AND action LIKE 'incident.%'`,
    ).trim(),
  ).toBe('incident.acknowledge,incident.resolve');
});
