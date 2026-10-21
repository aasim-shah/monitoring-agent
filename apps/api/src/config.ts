import { z } from 'zod';

const schema = z.object({
  DEPLOYMENT_MODE: z.enum(['managed', 'self_hosted']).default('managed'),
  API_PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
});

export interface AppConfig {
  deploymentMode: 'managed' | 'self_hosted';
  port: number;
  databaseUrl: string;
  redisUrl: string;
}

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`invalid configuration: ${issues}`);
  }
  const c = parsed.data;
  return {
    deploymentMode: c.DEPLOYMENT_MODE,
    port: c.API_PORT,
    databaseUrl: c.DATABASE_URL,
    redisUrl: c.REDIS_URL,
  };
}
