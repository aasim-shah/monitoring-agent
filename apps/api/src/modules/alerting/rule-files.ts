import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Writes a tenant's vmalert file atomically: vmalert never reads a half-written file. */
export async function writeTenantRules(dir: string, organizationId: string, yaml: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const target = join(dir, `tenant-${organizationId}.yaml`);
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, yaml, { mode: 0o644 });
  await rename(tmp, target);
}

/** Asks vmalert to re-read its rules; it also re-reads them every minute on its own. */
export async function reloadVmalert(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/-/reload`, { method: 'POST', signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}
