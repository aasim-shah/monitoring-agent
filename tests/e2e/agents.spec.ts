import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { CADDY_ADDRESS, E2E_WORK_DIR, PROJECT } from './helpers/env';
import { linkPath, waitForMail } from './helpers/mailpit';
import { nowSeconds, totp } from './helpers/totp';

const PASSWORD = 'correct horse battery staple';
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

/** Runs the real Go agent (TestLiveControlFlow) on the Compose edge network with the UI's token. */
function startAgent(token: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      'scripts/go.sh',
      ['test', '-count=1', '-run', 'TestLiveControlFlow', '-v', './agents/host-agent-go/internal/control'],
      {
        cwd: repoRoot,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          GO_DOCKER_NETWORK: `${PROJECT}_edge`,
          PCP_CONTROL_URL: `https://${CADDY_ADDRESS}`,
          PCP_SERVER_NAME: 'agent.localhost',
          PCP_SERVER_CA: `/src/${join(E2E_WORK_DIR, 'caddy-root.crt').slice(repoRoot.length)}`,
          PCP_ENROLL_TOKEN: token,
        },
      },
    );
    let output = '';
    child.stdout.on('data', (d: Buffer) => (output += d.toString()));
    child.stderr.on('data', (d: Buffer) => (output += d.toString()));
    child.on('close', (code) => resolve({ code: code ?? -1, output }));
  });
}

test('agents: add server → agent connects → diagnostics → revoke (M5 exit gate in the UI)', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const email = `agents-${randomUUID()}@example.com`;

  await page.goto('/signup');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.goto(linkPath(await waitForMail(email, 'Verify your email')));
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByLabel('Organization name').fill('Agents Co');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await page.getByRole('button', { name: 'Set up authenticator app' }).click();
  const secret = (await page.getByTestId('mfa-secret').textContent())!.trim();
  await page.getByLabel('Authentication code').fill(totp(secret, nowSeconds()));
  await page.getByRole('button', { name: 'Turn on two-factor authentication' }).click();
  await page.getByRole('button', { name: 'I saved these codes' }).click();
  await page.getByRole('link', { name: /Agents Co/ }).click();
  await page.getByLabel('Product name').fill('getRestro');
  await page.getByRole('button', { name: 'Create product' }).click();
  await page.getByRole('link', { name: /getRestro/ }).click();
  await page.getByLabel('New environment').fill('production');
  await page.getByRole('button', { name: 'Add environment' }).click();
  await expect(page.getByRole('list', { name: 'Environments' }).getByText('production')).toBeVisible();

  // The setup checklist leads to Agents.
  await page.getByRole('link', { name: 'Add server' }).click();
  await expect(page.getByText('No servers yet')).toBeVisible();
  await page.getByRole('button', { name: 'Add server' }).click();
  await page.getByRole('button', { name: 'Create install command' }).click();
  const command = (await page.locator('pre').textContent())!;
  expect(command).toContain('--control-url https://agent.localhost');
  const token = /--token (pcp_enr_[A-Za-z0-9_-]+)/.exec(command)![1]!;
  await expect(page.getByText(/Waiting for servers/)).toBeVisible();

  const agent = startAgent(token);
  let finished: { code: number; output: string } | undefined;
  void agent.then((r) => (finished = r));
  // Fails fast with the agent's own log if it exits before connecting.
  await expect
    .poll(
      async () =>
        finished
          ? `agent exited ${finished.code}: ${finished.output.slice(-2500)}`
          : (await page.getByText('Connected: e2e-host').isVisible())
            ? 'connected'
            : 'waiting',
      { timeout: 120_000, intervals: [1000] },
    )
    .toBe('connected');
  await page.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Add server' }).click();
  await expect(page.locator('pre')).toHaveCount(0);
  await page.getByRole('button', { name: 'Close' }).click();

  await page.getByRole('link', { name: 'e2e-host' }).click();
  await expect(page.getByRole('heading', { name: /e2e-host/ })).toBeVisible();
  await expect(page.getByText('Active', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Run diagnostics' }).click();
  await expect(page.getByText('"hostname": "e2e-host"')).toBeVisible({ timeout: 60_000 });

  // The agent rotates its certificate after answering; revoke once it has.
  await page.waitForTimeout(3000);
  await page.getByRole('button', { name: 'Revoke' }).click();
  await page.getByRole('button', { name: 'Revoke agent' }).click();
  await expect(page.getByText('Revoked', { exact: true })).toBeVisible();

  const result = await agent;
  expect(result.code, result.output.slice(-3000)).toBe(0);
  expect(result.output).toContain('--- PASS: TestLiveControlFlow');
});
