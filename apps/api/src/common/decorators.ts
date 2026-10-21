import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'pcp:public';
export const ALLOW_MFA_PENDING = 'pcp:allow-mfa-pending';

/** No session required. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Reachable before the second factor is verified or enrolled (MFA, logout, /me). */
export const AllowMfaPending = () => SetMetadata(ALLOW_MFA_PENDING, true);
