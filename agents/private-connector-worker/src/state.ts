import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface WorkerState {
  agentId: string;
  controlUrl: string;
  taskSigningPublicKey: string;
  notAfter: string;
  /** Extra TLS root for a development control plane. */
  caFile?: string;
}

export async function loadState(dir: string): Promise<WorkerState | undefined> {
  try {
    return JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) as WorkerState;
  } catch {
    return undefined;
  }
}

export async function saveState(dir: string, state: WorkerState): Promise<void> {
  await writeFile(join(dir, 'state.json'), JSON.stringify(state, null, 2), { mode: 0o600 });
}
