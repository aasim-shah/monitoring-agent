import 'reflect-metadata';
import { generateKeyPairSync, webcrypto } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { hostname, arch, platform, release } from 'node:os';
import { join } from 'node:path';
import * as x509 from '@peculiar/x509';
import { request } from './http.js';
import { saveState, type WorkerState } from './state.js';

x509.cryptoProvider.set(webcrypto as never);

export const VERSION = '0.1.0';

/** A fresh P-256 key and a CSR for it (the control plane sets the CN to the agent ID). */
export async function newKeyAndCsr(): Promise<{ keyPem: string; csrPem: string }> {
  const keys = (await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as webcrypto.CryptoKeyPair;
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: 'CN=pending',
    keys: keys as never,
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
  });
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey));
  const keyPem = `-----BEGIN PRIVATE KEY-----\n${pkcs8
    .toString('base64')
    .match(/.{1,64}/g)!
    .join('\n')}\n-----END PRIVATE KEY-----\n`;
  return { keyPem, csrPem: csr.toString('pem') };
}

/** UC-07-01: exchange the one-time token for a worker identity (same flow as host agents). */
export async function enroll(opts: {
  token: string;
  controlUrl: string;
  stateDir: string;
  caFile?: string;
}): Promise<WorkerState> {
  await mkdir(opts.stateDir, { recursive: true, mode: 0o700 });
  const { keyPem, csrPem } = await newKeyAndCsr();
  const x25519 = generateKeyPairSync('x25519');
  const x25519Public = Buffer.from(x25519.publicKey.export({ format: 'jwk' }).x!, 'base64url').toString(
    'base64',
  );
  const res = await request(opts.controlUrl, 'POST', '/agent/v1/enroll', {
    caFile: opts.caFile,
    body: {
      protocolVersion: '1.0',
      enrollmentToken: opts.token,
      agentVersion: VERSION,
      agentType: 'private_worker',
      csrPem,
      x25519PublicKey: x25519Public,
      host: {
        hostname: hostname(),
        machineId: `worker-${hostname()}`,
        os: `${platform()}-${release()}`,
        arch: arch() === 'x64' ? 'amd64' : arch(),
      },
    },
  });
  if (res.status !== 201)
    throw new Error(`enrollment failed: ${res.status} ${JSON.stringify(res.json).slice(0, 300)}`);
  const body = res.json as {
    agentId: string;
    certificatePem: string;
    chainPem: string;
    notAfter: string;
    taskSigningPublicKey: string;
  };
  await writeFile(join(opts.stateDir, 'worker.key'), keyPem, { mode: 0o600 });
  await writeFile(
    join(opts.stateDir, 'x25519.key'),
    x25519.privateKey.export({ format: 'pem', type: 'pkcs8' }),
    { mode: 0o600 },
  );
  await writeFile(join(opts.stateDir, 'worker.crt'), body.certificatePem, { mode: 0o600 });
  await writeFile(join(opts.stateDir, 'chain.pem'), body.chainPem, { mode: 0o600 });
  const state: WorkerState = {
    agentId: body.agentId,
    controlUrl: opts.controlUrl,
    taskSigningPublicKey: body.taskSigningPublicKey,
    notAfter: body.notAfter,
    caFile: opts.caFile,
  };
  await saveState(opts.stateDir, state);
  return state;
}
