export const READINESS_CHECKS = Symbol('READINESS_CHECKS');
export const APP_CONFIG = Symbol('APP_CONFIG');
export const PRISMA = Symbol('PRISMA');
export const REDIS = Symbol('REDIS');
export const KEY_RING = Symbol('KEY_RING');
/** `() => Date`; overridable in tests. */
export const CLOCK = Symbol('CLOCK');

/** `(hostname) => Promise<string[]>`: A/AAAA records for discovery's dns-to-host rule (tests inject a fake). */
export const DNS_RESOLVER = Symbol('DNS_RESOLVER');
