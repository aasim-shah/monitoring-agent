import type { webcrypto } from 'node:crypto';
import { x509 } from './x509.js';

export class InvalidCsrError extends Error {
  constructor(reason: string) {
    super(`invalid certificate signing request: ${reason}`);
    this.name = 'InvalidCsrError';
  }
}

const P256 = '1.2.840.10045.3.1.7';

/** Accepts only a self-signed PKCS#10 request for an ECDSA P-256 key (D11). */
export async function parseCsr(pem: string): Promise<{ publicKeyAlgorithm: 'P-256' }> {
  let req: x509.Pkcs10CertificateRequest;
  try {
    req = new x509.Pkcs10CertificateRequest(pem);
  } catch {
    throw new InvalidCsrError('not a PEM certificate request');
  }
  const alg = req.publicKey.algorithm as webcrypto.EcKeyAlgorithm;
  const curve = alg.namedCurve;
  if (alg.name !== 'ECDSA' || (curve !== 'P-256' && curve !== P256))
    throw new InvalidCsrError('key must be ECDSA P-256');
  let valid = false;
  try {
    valid = await req.verify();
  } catch {
    valid = false;
  }
  if (!valid) throw new InvalidCsrError('signature does not verify');
  return { publicKeyAlgorithm: 'P-256' };
}
