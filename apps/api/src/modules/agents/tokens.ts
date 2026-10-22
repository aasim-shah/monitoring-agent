import { createHmac, hkdfSync, randomBytes } from 'node:crypto';

/** Single-use enrollment secrets: `pcp_enr_` + 256 random bits, stored only as a peppered HMAC (§3). */
export class EnrollmentTokens {
  private readonly pepper: Buffer;

  constructor(masterKey: Buffer) {
    this.pepper = Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), 'pcp-enrollment-pepper', 32));
  }

  generate(): string {
    return `pcp_enr_${randomBytes(32).toString('base64url')}`;
  }

  hash(token: string): string {
    return createHmac('sha256', this.pepper).update(token).digest('hex');
  }
}
