import { z } from 'zod';

const schema = z
  .object({
    DEPLOYMENT_MODE: z.enum(['managed', 'self_hosted']).default('managed'),
    BOOTSTRAP_MODE: z.enum(['private_http', 'off']).default('private_http'),
    API_PORT: z.coerce.number().int().min(0).max(65535).default(3000),
    APP_ORIGIN: z.string().url().default('http://localhost:8080'),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    SMTP_URL: z.string().min(1).optional(),
    MAIL_FROM: z.string().min(3).default('Product Control Plane <no-reply@localhost>'),
    GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
    GOOGLE_REDIRECT_URI: z.string().url().optional(),
  })
  .refine(
    (c) =>
      [c.GOOGLE_CLIENT_ID, c.GOOGLE_CLIENT_SECRET, c.GOOGLE_REDIRECT_URI].every((v) => v === undefined) ||
      [c.GOOGLE_CLIENT_ID, c.GOOGLE_CLIENT_SECRET, c.GOOGLE_REDIRECT_URI].every((v) => v !== undefined),
    {
      message: 'set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI together',
      path: ['GOOGLE_CLIENT_ID'],
    },
  );

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface AppConfig {
  deploymentMode: 'managed' | 'self_hosted';
  bootstrapMode: 'private_http' | 'off';
  port: number;
  appOrigin: string;
  databaseUrl: string;
  redisUrl: string;
  smtpUrl?: string;
  mailFrom: string;
  google?: GoogleConfig;
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
    bootstrapMode: c.BOOTSTRAP_MODE,
    port: c.API_PORT,
    appOrigin: new URL(c.APP_ORIGIN).origin,
    databaseUrl: c.DATABASE_URL,
    redisUrl: c.REDIS_URL,
    smtpUrl: c.SMTP_URL,
    mailFrom: c.MAIL_FROM,
    google: c.GOOGLE_CLIENT_ID
      ? {
          clientId: c.GOOGLE_CLIENT_ID,
          clientSecret: c.GOOGLE_CLIENT_SECRET!,
          redirectUri: c.GOOGLE_REDIRECT_URI!,
        }
      : undefined,
  };
}
