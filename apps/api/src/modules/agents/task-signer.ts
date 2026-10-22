import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';

/** Ed25519 task signing (master plan §3, BR-03-07). */
export class TaskSigner {
  private constructor(private readonly key: KeyObject) {}

  static fromPem(pkcs8Pem: string): TaskSigner {
    const key = createPrivateKey(pkcs8Pem);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('TASK_SIGNING_KEY must be an Ed25519 key');
    return new TaskSigner(key);
  }

  /** Raw 32-byte public key, base64: `EnrollResponse.taskSigningPublicKey`. */
  publicKeyBase64(): string {
    const jwk = createPublicKey(this.key).export({ format: 'jwk' });
    return Buffer.from(jwk.x!, 'base64url').toString('base64');
  }
}
