import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { bootstrapRoles, type RolePasswords } from './bootstrap.js';
import { withCredentials } from './urls.js';

/** Package root (contains prisma/), from either src/ or dist/. */
const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const prismaEntry = createRequire(import.meta.url).resolve('prisma/build/index.js');

export interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Runs the Prisma CLI from this package (async, so long runs never block the event loop). */
export function prismaCli(args: string[], env: Record<string, string>): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [prismaEntry, ...args], {
      cwd: packageRoot,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        PRISMA_HIDE_UPDATE_MESSAGE: '1',
        ...env,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ status: code ?? -1, stdout, stderr }));
  });
}

export interface MigrateOptions {
  superuserUrl: string;
  passwords: RolePasswords;
}

/** Bootstraps roles as superuser, then applies migrations as pcp_migrator. */
export async function migrate({ superuserUrl, passwords }: MigrateOptions): Promise<void> {
  await bootstrapRoles(superuserUrl, passwords);
  const result = await prismaCli(['migrate', 'deploy', '--schema', 'prisma/schema.prisma'], {
    DATABASE_URL: withCredentials(superuserUrl, 'pcp_migrator', passwords.migrator),
  });
  if (result.status !== 0) {
    throw new Error(
      `prisma migrate deploy failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`,
    );
  }
}
