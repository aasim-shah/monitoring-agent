import { z } from 'zod';

const schema = z.object({
  DEPLOYMENT_MODE: z.enum(['managed', 'self_hosted']).default('managed'),
  WORKER_HEALTH_PORT: z.coerce.number().int().min(0).max(65535).default(3002),
  REDIS_URL: z.string().min(1),
});

export interface WorkerConfig {
  deploymentMode: 'managed' | 'self_hosted';
  healthPort: number;
  redisUrl: string;
}

export function loadConfig(env: Record<string, string | undefined>): WorkerConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`invalid configuration: ${issues}`);
  }
  const c = parsed.data;
  return { deploymentMode: c.DEPLOYMENT_MODE, healthPort: c.WORKER_HEALTH_PORT, redisUrl: c.REDIS_URL };
}
