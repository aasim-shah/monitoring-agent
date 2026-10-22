const MIN_SECRET_LENGTH = 4;

/** Replaces every occurrence of each secret value with [REDACTED]. */
export function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < MIN_SECRET_LENGTH) continue;
    out = out.split(secret).join('[REDACTED]');
  }
  return out;
}
