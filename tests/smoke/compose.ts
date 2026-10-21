import { spawn } from 'node:child_process';
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

// Asynchronous on purpose: a synchronous spawn blocks the Vitest worker for minutes during
// `compose up --build`, which times out the worker's RPC channel.
export function run(cmd: string, args: string[], env: Record<string, string> = {}): Promise<Run> {
  // Start from a minimal environment so a developer's shell or .env never leaks into the test.
  const base: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };
  if (process.env.DOCKER_HOST) base.DOCKER_HOST = process.env.DOCKER_HOST;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: repoRoot, env: { ...base, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ status: code ?? -1, stdout, stderr }));
  });
}

export function envFile(vars: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'pcp-smoke-'));
  const file = join(dir, '.env');
  writeFileSync(file, Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  return file;
}

export function compose(project: string, file: string, args: string[]): Promise<Run> {
  return run('docker', ['compose', '-p', project, '--env-file', file, '-f', 'compose.yaml', ...args]);
}

export const SECRETS = {
  POSTGRES_PASSWORD: 'smoke0postgres0password0hex',
  REDIS_PASSWORD: 'smoke0redis0password0hex',
};
