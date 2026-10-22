// Reuses the API's RFC 6238 implementation (tested against the RFC vectors).
export { totp } from '../../../apps/api/src/modules/identity/totp';

export const nowSeconds = () => Math.floor(Date.now() / 1000);
