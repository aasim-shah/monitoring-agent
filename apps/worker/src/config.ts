import { z } from 'zod';

const schema = z.object({
  DEPLOYMENT_MODE: z.enum(['managed', 'self_hosted']).default('managed'),
  WORKER_HEALTH_PORT: z.coerce.number().int().min(0).max(65535).default(3002),
  REDIS_URL: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  /** Connects as pcp_scheduler (reads schedules through pcp_due_job_definitions only). */
  SCHEDULER_DATABASE_URL: z.string().min(1),
  RECONCILE_EVERY_SECONDS: z.coerce.number().int().min(5).default(60),
});

export interface WorkerConfig {
  deploymentMode: 'managed' | 'self_hosted';
  healthPort: number;
  redisUrl: string;
  databaseUrl: string;
  schedulerDatabaseUrl: string;
  reconcileEverySeconds: number;
}

export function loadConfig(env: Record<string, string | undefined>): WorkerConfig {
  // Compose passes "" for `${VAR:-}`; treat empty values as unset.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`invalid configuration: ${issues}`);
  }
  const c = parsed.data;
  return {
    deploymentMode: c.DEPLOYMENT_MODE,
    healthPort: c.WORKER_HEALTH_PORT,
    redisUrl: c.REDIS_URL,
    databaseUrl: c.DATABASE_URL,
    schedulerDatabaseUrl: c.SCHEDULER_DATABASE_URL,
    reconcileEverySeconds: c.RECONCILE_EVERY_SECONDS,
  };
}
