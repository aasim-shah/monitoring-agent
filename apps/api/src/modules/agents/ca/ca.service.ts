import { createHash, randomBytes } from 'node:crypto';
import { parseCsr } from './csr.js';
import { subtle, x509, type CryptoKey, type EcdsaParams } from './x509.js';

const VALIDITY_MS = 30 * 24 * 3600_000;
/** Tolerates small clock differences between the API and the host. */
const BACKDATE_MS = 5 * 60_000;
const SIGN = { name: 'ECDSA', hash: 'SHA-256' } as EcdsaParams;

export interface IssuedCertificate {
  certificatePem: string;
  chainPem: string;
  notAfter: string;
  serial: string;
  /** SHA-256 of the certificate DER, lowercase hex: what Caddy forwards. */
  fingerprintSha256: string;
}

/** The online intermediate CA that signs agent client certificates (D11). */
export class AgentCa {
  private constructor(
    private readonly cert: x509.X509Certificate,
    private readonly key: CryptoKey,
    private readonly chainPem: string,
  ) {}

  static async fromPem(certPem: string, keyPem: string, chainPem: string): Promise<AgentCa> {
    const der = Buffer.from(keyPem.replace(/-----[^-]+-----|\s/g, ''), 'base64');
    const key = await subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    return new AgentCa(new x509.X509Certificate(certPem), key, chainPem);
  }

  /** Signs a host-generated P-256 CSR as `CN=<agentId>`, EKU clientAuth, valid 30 days. */
  async issue(csrPem: string, agentId: string, now = new Date()): Promise<IssuedCertificate> {
    await parseCsr(csrPem);
    const csr = new x509.Pkcs10CertificateRequest(csrPem);
    const cert = await x509.X509CertificateGenerator.create({
      serialNumber: randomBytes(16)
        .toString('hex')
        .replace(/^[89a-f]/, '1'),
      subject: `CN=${agentId}`,
      issuer: this.cert.subject,
      notBefore: new Date(now.getTime() - BACKDATE_MS),
      notAfter: new Date(now.getTime() + VALIDITY_MS),
      publicKey: csr.publicKey,
      signingKey: this.key,
      signingAlgorithm: SIGN,
      extensions: [
        new x509.BasicConstraintsExtension(false, undefined, true),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
        new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.clientAuth], false),
        await x509.AuthorityKeyIdentifierExtension.create(this.cert),
      ],
    });
    return {
      certificatePem: cert.toString('pem'),
      chainPem: this.chainPem,
      notAfter: cert.notAfter.toISOString(),
      serial: cert.serialNumber,
      fingerprintSha256: createHash('sha256').update(Buffer.from(cert.rawData)).digest('hex'),
    };
  }
}
