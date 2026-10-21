export interface EncryptedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  wrappedKey: Buffer;
  keyVersion: number;
  algorithm: 'AES-256-GCM';
}
