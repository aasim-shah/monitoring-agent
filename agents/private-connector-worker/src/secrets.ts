import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';

export const SECRETS_DIR = '/etc/pcp-worker/secrets';

/** BR-07-07: a simple name; never a path. */
const SECRET_REF = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/**
 * Database and API credentials live only here, on the customer's server
 * (`<dir>/<secretRef>.yaml`, a flat map of strings); the control plane knows the name only.
 */
export async function loadSecret(secretRef: string, dir = SECRETS_DIR): Promise<Record<string, string>> {
  if (!SECRET_REF.test(secretRef) || secretRef.includes('..'))
    throw new Error(`secretRef ${JSON.stringify(secretRef)} must be a simple name (letters, digits, . _ -)`);
  let text: string;
  try {
    text = await readFile(join(dir, `${secretRef}.yaml`), 'utf8');
  } catch {
    throw new Error(`secret ${secretRef} not found in ${dir}`);
  }
  const doc: unknown = parse(text);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc))
    throw new Error(`secret ${secretRef} must be a flat map of strings`);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(doc)) {
    if (typeof v !== 'string' && typeof v !== 'number')
      throw new Error(`secret ${secretRef} must be a flat map of strings`);
    out[k] = String(v);
  }
  return out;
}
