import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import { webcrypto } from 'node:crypto';
import * as x509 from '@peculiar/x509';
import { beforeAll, describe, expect, it } from 'vitest';
import { AgentCa } from './ca.service.js';
import { InvalidCsrError, parseCsr } from './csr.js';
import { generateDevPki, type DevPki } from './pki.js';

const subtle = webcrypto.subtle;
type Gen = webcrypto.EcKeyGenParams | webcrypto.RsaHashedKeyGenParams;
type Sign = webcrypto.Algorithm | webcrypto.EcdsaParams;
let pki: DevPki;
let ca: AgentCa;

async function csr(algorithm: Gen, signing: Sign) {
  const keys = (await subtle.generateKey(algorithm, true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
  const req = await x509.Pkcs10CertificateRequestGenerator.create({
    name: 'CN=pending',
    keys,
    signingAlgorithm: signing,
  });
  return req.toString('pem');
}

const p256 = () =>
  csr({ name: 'ECDSA', namedCurve: 'P-256' }, { name: 'ECDSA', hash: 'SHA-256' } as webcrypto.EcdsaParams);

beforeAll(async () => {
  pki = await generateDevPki();
  ca = await AgentCa.fromPem(pki.intermediateCertPem, pki.intermediateKeyPem, pki.chainPem);
});

describe('AgentCa.issue', () => {
  it('issues a 30-day clientAuth certificate for CN=<agentId> chaining to the root (TC-03-04)', async () => {
    const agentId = randomUUID();
    const now = new Date('2026-10-22T12:00:00Z');
    const issued = await ca.issue(await p256(), agentId, now);
    const cert = new x509.X509Certificate(issued.certificatePem);
    expect(cert.subject).toBe(`CN=${agentId}`);
    const eku = cert.getExtension(x509.ExtendedKeyUsageExtension);
    expect(eku?.usages).toContain(x509.ExtendedKeyUsage.clientAuth);
    expect(cert.notBefore.getTime()).toBe(now.getTime() - 5 * 60_000);
    expect(cert.notAfter.getTime()).toBe(now.getTime() + 30 * 24 * 3600_000);
    expect(issued.notAfter).toBe(cert.notAfter.toISOString());
    const intermediate = new x509.X509Certificate(pki.intermediateCertPem);
    const root = new x509.X509Certificate(pki.rootCertPem);
    expect(await cert.verify({ publicKey: intermediate.publicKey, date: now })).toBe(true);
    expect(await intermediate.verify({ publicKey: root.publicKey, date: now })).toBe(true);
    expect(issued.chainPem).toContain(intermediate.toString('pem').split('\n')[1]);
    expect(issued.fingerprintSha256).toBe(
      createHash('sha256').update(Buffer.from(cert.rawData)).digest('hex'),
    );
    expect(issued.serial).toBe(cert.serialNumber);
  });

  it('issues unique serials', async () => {
    const a = await ca.issue(await p256(), randomUUID());
    const b = await ca.issue(await p256(), randomUUID());
    expect(a.serial).not.toBe(b.serial);
  });
});

describe('parseCsr', () => {
  it('accepts a P-256 CSR', async () => {
    expect(await parseCsr(await p256())).toEqual({ publicKeyAlgorithm: 'P-256' });
  });

  it('rejects P-384 and RSA keys', async () => {
    const p384 = await csr({ name: 'ECDSA', namedCurve: 'P-384' }, {
      name: 'ECDSA',
      hash: 'SHA-384',
    } as webcrypto.EcdsaParams);
    const rsa = await csr(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      { name: 'RSASSA-PKCS1-v1_5' },
    );
    await expect(parseCsr(p384)).rejects.toBeInstanceOf(InvalidCsrError);
    await expect(parseCsr(rsa)).rejects.toBeInstanceOf(InvalidCsrError);
  });

  it('rejects a CSR whose signature does not verify', async () => {
    const pem = await p256();
    const der = Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ''), 'base64');
    const at = der.length - 5;
    der[at] = der[at]! ^ 0xff;
    const tampered = `-----BEGIN CERTIFICATE REQUEST-----\n${der.toString('base64')}\n-----END CERTIFICATE REQUEST-----`;
    await expect(parseCsr(tampered)).rejects.toBeInstanceOf(InvalidCsrError);
  });

  it('rejects garbage', async () => {
    await expect(parseCsr('not a csr')).rejects.toBeInstanceOf(InvalidCsrError);
  });
});
