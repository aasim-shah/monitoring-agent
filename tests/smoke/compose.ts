import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

export interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

export function run(cmd: string, args: string[], env: Record<string, string> = {}): Run {
  // Start from a minimal environment so a developer's shell or .env never leaks into the test.
  const base: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };
  if (process.env.DOCKER_HOST) base.DOCKER_HOST = process.env.DOCKER_HOST;
  const r = spawnSync(cmd, args, { cwd: repoRoot, env: { ...base, ...env }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

export function envFile(vars: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'pcp-smoke-'));
  const file = join(dir, '.env');
  writeFileSync(file, Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  return file;
}

export function compose(project: string, file: string, args: string[]): Run {
  return run('docker', ['compose', '-p', project, '--env-file', file, '-f', 'compose.yaml', ...args]);
}

export const SECRETS = {
  POSTGRES_PASSWORD: 'smoke0postgres0password0hex',
  REDIS_PASSWORD: 'smoke0redis0password0hex',
};
