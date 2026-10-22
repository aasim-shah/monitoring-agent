import 'reflect-metadata';
import { webcrypto } from 'node:crypto';
import * as x509 from '@peculiar/x509';
import { generateDevPki, type DevPki } from '../src/modules/agents/ca/pki.js';
import type { TestApp } from './app-factory.js';
import { createProduct, headers, type Owner } from './auth-helpers.js';

export const CADDY_ADDRESS = '172.30.0.10';

let pki: Promise<DevPki> | undefined;
/** One PKI per test file; generating keys is slow enough to share. */
export const testPki = () => (pki ??= generateDevPki());

export async function agentEnv(): Promise<Record<string, string>> {
  const p = await testPki();
  const b64 = (s: string) => Buffer.from(s).toString('base64');
  return {
    AGENT_CA_CERT: b64(p.intermediateCertPem),
    AGENT_CA_KEY: b64(p.intermediateKeyPem),
    AGENT_CA_CHAIN: b64(p.chainPem),
    TASK_SIGNING_KEY: b64(p.taskSigningKeyPem),
    AGENT_CONTROL_URL: 'https://agent.example.test',
    AGENT_INGEST_URL: 'https://ingest.example.test',
    AGENT_OPAMP_URL: 'wss://agent.example.test/agent/v1/opamp',
    AGENT_PROXY_ADDRESSES: CADDY_ADDRESS,
  };
}

/** A P-256 CSR as the host agent would generate it. */
export async function agentCsr(): Promise<string> {
  const keys = (await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as webcrypto.CryptoKeyPair;
  const req = await x509.Pkcs10CertificateRequestGenerator.create(
    {
      name: 'CN=pending',
      keys: keys as never,
      signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' } as never,
    },
    webcrypto as never,
  );
  return req.toString('pem');
}

export async function enrollRequest(
  token: string,
  host: Partial<{ hostname: string; machineId: string }> = {},
) {
  return {
    protocolVersion: '1.0',
    enrollmentToken: token,
    agentVersion: '1.0.0',
    agentType: 'host',
    csrPem: await agentCsr(),
    x25519PublicKey: Buffer.alloc(32, 9).toString('base64'),
    host: { hostname: 'vps-1', machineId: 'machine-1', os: 'ubuntu-24.04', arch: 'amd64', ...host },
  };
}

/** Product + "production" environment for an owner; returns the environment ID. */
export async function environmentFor(
  t: TestApp,
  owner: Owner,
): Promise<{ productId: string; environmentId: string }> {
  const productId = await createProduct(t, owner, `P-${Math.random().toString(36).slice(2, 8)}`);
  const res = await t.app.inject({
    method: 'POST',
    url: `/api/v1/products/${productId}/environments`,
    headers: headers(owner.cookie),
    payload: { name: 'production' },
  });
  return { productId, environmentId: (res.json() as { id: string }).id };
}

export async function createEnrollment(
  t: TestApp,
  owner: Owner,
  environmentId: string,
  body: Record<string, unknown> = {},
): Promise<{ id: string; token: string; expiresAt: string; maxUses: number; installCommand: string }> {
  const res = await t.app.inject({
    method: 'POST',
    url: `/api/v1/environments/${environmentId}/agent-enrollments`,
    headers: headers(owner.cookie),
    payload: body,
  });
  if (res.statusCode !== 201) throw new Error(`enrollment failed ${res.statusCode} ${res.body}`);
  return res.json();
}

export interface EnrolledAgent {
  agentId: string;
  fingerprint: string;
  certificatePem: string;
}

/** Enrolls a fresh agent through the API; the fingerprint is what Caddy would forward. */
export async function enrolledAgent(
  t: TestApp,
  owner: Owner,
  environmentId: string,
  host: Partial<{ hostname: string; machineId: string }> = {},
): Promise<EnrolledAgent> {
  const { createHash } = await import('node:crypto');
  const e = await createEnrollment(t, owner, environmentId);
  const res = await t.app.inject({
    method: 'POST',
    url: '/agent/v1/enroll',
    payload: await enrollRequest(e.token, host),
  });
  if (res.statusCode !== 201) throw new Error(`enroll failed ${res.statusCode} ${res.body}`);
  const body = res.json() as { agentId: string; certificatePem: string };
  const der = Buffer.from(body.certificatePem.replace(/-----[^-]+-----|\s/g, ''), 'base64');
  return { ...body, fingerprint: createHash('sha256').update(der).digest('hex') };
}

/** A request as Caddy forwards it: from Caddy's address with the client certificate fingerprint. */
export function asAgent(fingerprint: string, from = CADDY_ADDRESS) {
  return { remoteAddress: from, headers: { 'x-client-cert-fingerprint': fingerprint } };
}
