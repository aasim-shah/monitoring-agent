import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { canonicalJson } from '@pcp/agent-protocol';
import { describe, expect, it } from 'vitest';
import { TaskSigner } from './task-signer.js';

const pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const task = {
  id: '6f1c2f0e-6b9a-4c1e-9d2a-1f3e5b7c9d01',
  type: 'inspect' as const,
  expiresAt: '2026-10-22T12:10:00.000Z',
  resourceScope: {},
  maxRuntimeSeconds: 60,
  maxResponseBytes: 65536,
  payload: { target: 'agent_info' },
};

const publicKey = (signer: TaskSigner) =>
  createPublicKey({
    key: {
      kty: 'OKP',
      crv: 'Ed25519',
      x: Buffer.from(signer.publicKeyBase64(), 'base64').toString('base64url'),
    },
    format: 'jwk',
  });

describe('TaskSigner (BR-03-07)', () => {
  it('signs the canonical JSON of the task without its signature', () => {
    const signer = TaskSigner.fromPem(pem);
    const signature = signer.sign(task);
    expect(
      verify(null, Buffer.from(canonicalJson(task)), publicKey(signer), Buffer.from(signature, 'base64')),
    ).toBe(true);
  });

  it('a tampered payload fails verification (TC-03-11)', () => {
    const signer = TaskSigner.fromPem(pem);
    const signature = signer.sign(task);
    const tampered = { ...task, payload: { target: 'agent_infp' } };
    expect(
      verify(null, Buffer.from(canonicalJson(tampered)), publicKey(signer), Buffer.from(signature, 'base64')),
    ).toBe(false);
  });

  it('refuses a non-Ed25519 key', () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    expect(() => TaskSigner.fromPem(ec)).toThrow(/Ed25519/);
  });
});
