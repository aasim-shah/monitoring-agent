import { aiConfigFromEnv, type AiConfig } from '@pcp/ai-orchestrator';
import { z } from 'zod';

const schema = z.object({
  DEPLOYMENT_MODE: z.enum(['managed', 'self_hosted']).default('managed'),
  WORKER_HEALTH_PORT: z.coerce.number().int().min(0).max(65535).default(3002),
  REDIS_URL: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  /** Connects as pcp_scheduler (reads schedules through pcp_due_job_definitions only). */
  SCHEDULER_DATABASE_URL: z.string().min(1),
  RECONCILE_EVERY_SECONDS: z.coerce.number().int().min(5).default(60),
  /** Incident notifications (M12.3): unset SMTP_URL logs instead of sending email. */
  SMTP_URL: z.string().url().optional(),
  MAIL_FROM: z.string().min(3).default('Product Control Plane <alerts@localhost>'),
  /** Links in notifications point here. */
  APP_ORIGIN: z.string().url().default('http://localhost:8080'),
  /** Website probe samples (M13a). */
  VM_IMPORT_URL: z.string().url().optional(),
  /** Test stacks only: private host:port targets the probe may reach (comma-separated). */
  PCP_PROBE_ALLOWLIST: z.string().optional(),
  /** Daily report numbers (M15): tenant-scoped instant queries. */
  VM_QUERY_URL: z.string().url().optional(),
});

export interface WorkerConfig {
  deploymentMode: 'managed' | 'self_hosted';
  healthPort: number;
  redisUrl: string;
  databaseUrl: string;
  schedulerDatabaseUrl: string;
  reconcileEverySeconds: number;
  smtpUrl?: string;
  mailFrom: string;
  appOrigin: string;
  vmImportUrl?: string;
  probeAllowlist: string[];
  vmQueryUrl?: string;
  /** Report narratives (M15): the same providers as the AI assistant. */
  ai: AiConfig;
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
    smtpUrl: c.SMTP_URL,
    mailFrom: c.MAIL_FROM,
    appOrigin: new URL(c.APP_ORIGIN).origin,
    vmImportUrl: c.VM_IMPORT_URL?.replace(/\/+$/, ''),
    probeAllowlist: (c.PCP_PROBE_ALLOWLIST ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    vmQueryUrl: c.VM_QUERY_URL?.replace(/\/+$/, ''),
    ai: aiConfigFromEnv(cleaned),
  };
}
