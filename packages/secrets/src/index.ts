export {
  encryptSecret,
  decryptSecret,
  serializeSecret,
  deserializeSecret,
  type KeyEncryptionKey,
} from './envelope.js';
export { loadKeyRing, type KeyRing } from './key-ring.js';
export type { EncryptedSecret } from '@pcp/shared-contracts';
