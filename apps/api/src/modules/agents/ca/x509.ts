// @peculiar/x509 resolves its formatters through tsyringe, which needs the reflect polyfill.
import 'reflect-metadata';
import { webcrypto } from 'node:crypto';
import * as x509 from '@peculiar/x509';

x509.cryptoProvider.set(webcrypto as never);

export { x509 };
// The API compiles without the DOM lib; WebCrypto types come from node:crypto.
export type CryptoKey = webcrypto.CryptoKey;
export type CryptoKeyPair = webcrypto.CryptoKeyPair;
export type EcdsaParams = webcrypto.EcdsaParams;
export const subtle = webcrypto.subtle;
