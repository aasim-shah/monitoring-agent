import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson } from '@pcp/agent-protocol';
import { ConnectorError, ConnectorRegistry, type Connector } from '@pcp/connector-sdk';
import { describe, expect, it } from 'vitest';
import { MAX_RESULT_BYTES, capResult } from './limits.js';
import { runOp } from './ops.js';
import { loadSecret } from './secrets.js';
import { verifyTask } from './verify.js';

const vector = JSON.parse(
  readFileSync(
    new URL('../../../packages/agent-protocol/testdata/task-signature.json', import.meta.url),
    'utf8',
  ),
);

function signedTask(overrides: Record<string, unknown> = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'jwk' }).x!;
  const task = {
    id: '11111111-1111-4111-8111-111111111111',
    type: 'connector_op',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    resourceScope: {},
    maxRuntimeSeconds: 60,
    maxResponseBytes: 262144,
    payload: { operation: 'health' },
    ...overrides,
  };
  const signature = sign(null, Buffer.from(canonicalJson(task)), privateKey).toString('base64');
  return { task: { ...task, signature }, key: Buffer.from(raw, 'base64url').toString('base64') };
}

describe('verifyTask (BR-07-05, TC-07-01)', () => {
  it('accepts the shared vector signed by the control plane (until it expires)', () => {
    expect(verifyTask(vector.task, vector.publicKey, new Date('2026-10-22T12:00:00Z'))).toEqual({ ok: true });
  });

  it('refuses forged, unsigned, and expired tasks', () => {
    const { task, key } = signedTask();
    expect(verifyTask(task, key)).toEqual({ ok: true });
    expect(verifyTask({ ...task, payload: { operation: 'template' } }, key)).toMatchObject({
      ok: false,
      reason: 'bad signature',
    });
    const { signature: _, ...unsigned } = task;
    expect(verifyTask(unsigned, key)).toMatchObject({ ok: false, reason: 'unsigned' });
    const expired = signedTask({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(verifyTask(expired.task, expired.key)).toMatchObject({ ok: false, reason: 'expired' });
    expect(verifyTask(task, signedTask().key)).toMatchObject({ ok: false, reason: 'bad signature' });
  });
});

describe('loadSecret (BR-07-07, TC-07-02)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pcp-secrets-'));
  writeFileSync(join(dir, 'firemaps-mongo.yaml'), 'username: monitor\npassword: "s3cret: with colon"\n');
  writeFileSync(join(dir, 'nested.yaml'), 'username: a\nextra:\n  deep: 1\n');

  it('reads a flat map of strings by simple name', async () => {
    await expect(loadSecret('firemaps-mongo', dir)).resolves.toEqual({
      username: 'monitor',
      password: 's3cret: with colon',
    });
  });

  it.each(['../x', 'a/b', '', '.hidden', 'x'.repeat(80), 'a\\b'])('refuses secretRef %j', async (ref) => {
    await expect(loadSecret(ref, dir)).rejects.toThrow(/secretRef/);
  });

  it('refuses files that are not a flat map of strings, and missing files', async () => {
    await expect(loadSecret('nested', dir)).rejects.toThrow(/flat map/);
    await expect(loadSecret('absent', dir)).rejects.toThrow(/not found/);
  });
});

describe('capResult (BR-07-04)', () => {
  it('trims the largest arrays to fit 256 KB and flags truncation', () => {
    const big = {
      rows: Array.from({ length: 6000 }, (_, i) => ({ i, text: 'x'.repeat(90) })),
      meta: { ok: true },
    };
    const capped = capResult(big) as { rows: unknown[]; truncated: boolean; meta: unknown };
    expect(Buffer.byteLength(JSON.stringify(capped))).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    expect(capped.truncated).toBe(true);
    expect(capped.rows.length).toBeGreaterThan(100);
    expect(capped.meta).toEqual({ ok: true });
    expect(capResult({ small: [1, 2] })).toEqual({ small: [1, 2] });
  });
});

describe('runOp', () => {
  const echo: Connector = {
    type: 'echo',
    version: '1',
    displayName: 'Echo',
    executionLocations: ['private'],
    credentialFields: [],
    capabilities: () => ['validate', 'health'],
    configSchema: () => ({}),
    async validate(ctx) {
      const { username } = await ctx.credentials();
      if (username === 'writer') throw new ConnectorError('permission_denied', 'user can write');
      return { ok: true, accountId: username };
    },
    async health(ctx) {
      return { ok: true, data: { host: ctx.config.host } };
    },
  };
  const registry = new ConnectorRegistry();
  registry.register(echo);
  const secrets = async (ref: string) => ({ username: ref === 'w' ? 'writer' : 'reader' });

  it('runs validate and health with credentials from the local secret', async () => {
    await expect(
      runOp(
        { connectionId: 'c', provider: 'echo', operation: 'validate', config: { secretRef: 'r' } },
        { registry, loadSecret: secrets },
      ),
    ).resolves.toEqual({
      status: 'succeeded',
      result: { operation: 'validate', ok: true, accountId: 'reader' },
    });
    await expect(
      runOp(
        { connectionId: 'c', provider: 'echo', operation: 'health', config: { secretRef: 'r', host: 'db' } },
        { registry, loadSecret: secrets },
      ),
    ).resolves.toMatchObject({
      status: 'succeeded',
      result: { operation: 'health', ok: true, data: { host: 'db' } },
    });
  });

  it('reports connector failures with their reason, unknown providers, and unsupported operations', async () => {
    await expect(
      runOp(
        { connectionId: 'c', provider: 'echo', operation: 'validate', config: { secretRef: 'w' } },
        { registry, loadSecret: secrets },
      ),
    ).resolves.toEqual({
      status: 'failed',
      error: 'user can write',
      result: { operation: 'validate', reason: 'permission_denied' },
    });
    await expect(
      runOp(
        { connectionId: 'c', provider: 'nope', operation: 'health', config: {} },
        { registry, loadSecret: secrets },
      ),
    ).resolves.toMatchObject({ status: 'failed', result: { reason: 'invalid_config' } });
    await expect(
      runOp(
        { connectionId: 'c', provider: 'echo', operation: 'template', config: {}, template: 'x' },
        { registry, loadSecret: secrets },
      ),
    ).resolves.toMatchObject({ status: 'failed', result: { reason: 'invalid_config' } });
  });
});
