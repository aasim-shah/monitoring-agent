/**
 * BR-10-08: observation attributes are stored only after secrets are removed. Keys that
 * name a secret are blanked; values that look like credentials are blanked or, for URLs,
 * keep everything but the password.
 */
const SECRET_KEY = /pass|secret|token|apikey|api_key|credential|auth|private_?key|^key$|session|cookie/i;
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/[^:/\s@]+:)[^@\s]+(@)/gi;
const SECRET_VALUE = [
  /^Bearer\s+\S+/i,
  /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\b(sk|rk)_(live|test)_[A-Za-z0-9]{10,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bpcp_enr_[A-Za-z0-9_-]{20,}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/,
];

export const REDACTED = '[redacted]';

function redactValue(v: string): string {
  if (SECRET_VALUE.some((re) => re.test(v))) return REDACTED;
  return v.replace(URL_CREDENTIALS, `$1${REDACTED}$2`);
}

export function redactAttributes<T>(value: T, key?: string): T {
  if (key !== undefined && SECRET_KEY.test(key) && (typeof value === 'string' || typeof value === 'number'))
    return REDACTED as T;
  if (typeof value === 'string') return redactValue(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactAttributes(v)) as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactAttributes(v, k)])) as T;
  return value;
}
