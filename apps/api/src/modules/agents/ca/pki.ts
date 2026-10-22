import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { subtle, x509, type CryptoKey, type CryptoKeyPair, type EcdsaParams } from './x509.js';

export interface DevPki {
  rootCertPem: string;
  rootKeyPem: string;
  intermediateCertPem: string;
  intermediateKeyPem: string;
  /** Intermediate then root: what Caddy trusts and what agents receive. */
  chainPem: string;
  /** PKCS#8 Ed25519 key for task signing. */
  taskSigningKeyPem: string;
}

const EC = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN = { name: 'ECDSA', hash: 'SHA-256' } as EcdsaParams;
const YEAR = 365 * 24 * 3600_000;

async function exportKey(key: CryptoKey): Promise<string> {
  const der = Buffer.from(await subtle.exportKey('pkcs8', key));
  return `-----BEGIN PRIVATE KEY-----\n${der
    .toString('base64')
    .replace(/(.{64})/g, '$1\n')
    .trim()}\n-----END PRIVATE KEY-----\n`;
}

/**
 * A root and intermediate CA for development, tests, and self-hosted bootstrap (D11).
 * In production the root key stays offline; only the intermediate is configured.
 */
export async function generateDevPki(now = new Date()): Promise<DevPki> {
  const rootKeys = (await subtle.generateKey(EC, true, ['sign', 'verify'])) as CryptoKeyPair;
  const root = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: randomBytes(16).toString('hex'),
    name: 'CN=PCP Agent Root CA',
    notBefore: now,
    notAfter: new Date(now.getTime() + 10 * YEAR),
    keys: rootKeys,
    signingAlgorithm: SIGN,
    extensions: [
      new x509.BasicConstraintsExtension(true, 1, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      await x509.SubjectKeyIdentifierExtension.create(rootKeys.publicKey),
    ],
  });
  const intKeys = (await subtle.generateKey(EC, true, ['sign', 'verify'])) as CryptoKeyPair;
  const intermediate = await x509.X509CertificateGenerator.create({
    serialNumber: randomBytes(16).toString('hex'),
    subject: 'CN=PCP Agent Intermediate CA',
    issuer: root.subject,
    notBefore: now,
    notAfter: new Date(now.getTime() + 3 * YEAR),
    publicKey: intKeys.publicKey,
    signingKey: rootKeys.privateKey,
    signingAlgorithm: SIGN,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      await x509.SubjectKeyIdentifierExtension.create(intKeys.publicKey),
      await x509.AuthorityKeyIdentifierExtension.create(root),
    ],
  });
  const ed = generateKeyPairSync('ed25519');
  const rootCertPem = root.toString('pem');
  const intermediateCertPem = intermediate.toString('pem');
  return {
    rootCertPem,
    rootKeyPem: await exportKey(rootKeys.privateKey),
    intermediateCertPem,
    intermediateKeyPem: await exportKey(intKeys.privateKey),
    chainPem: `${intermediateCertPem}\n${rootCertPem}\n`,
    taskSigningKeyPem: ed.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}
