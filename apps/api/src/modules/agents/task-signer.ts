import { createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto';
import { canonicalJson, type AgentTask } from '@pcp/agent-protocol';

/** Ed25519 task signing (master plan §3, BR-03-07). */
export class TaskSigner {
  private constructor(private readonly key: KeyObject) {}

  static fromPem(pkcs8Pem: string): TaskSigner {
    const key = createPrivateKey(pkcs8Pem);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('TASK_SIGNING_KEY must be an Ed25519 key');
    return new TaskSigner(key);
  }

  /** Base64 Ed25519 signature over the canonical JSON of the task without `signature`. */
  sign(task: Omit<AgentTask, 'signature'>): string {
    return sign(null, Buffer.from(canonicalJson(task), 'utf8'), this.key).toString('base64');
  }

  /** Raw 32-byte public key, base64: `EnrollResponse.taskSigningPublicKey`. */
  publicKeyBase64(): string {
    const jwk = createPublicKey(this.key).export({ format: 'jwk' });
    return Buffer.from(jwk.x!, 'base64url').toString('base64');
  }
}
