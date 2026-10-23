import { z } from 'zod';

/** Agent enrollment needs all of these, or none (enrollment is then unavailable). */
const AGENT_KEYS = [
  'AGENT_CA_CERT',
  'AGENT_CA_KEY',
  'AGENT_CA_CHAIN',
  'TASK_SIGNING_KEY',
  'AGENT_CONTROL_URL',
  'AGENT_INGEST_URL',
  'AGENT_OPAMP_URL',
] as const;

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
    /** The platform's public egress IP, shown to customers who allowlist it (e.g. MongoDB Atlas). */
    PLATFORM_EGRESS_IP: z.string().ip().optional(),
    GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
    GOOGLE_REDIRECT_URI: z.string().url().optional(),
    AGENT_CA_CERT: z.string().min(1).optional(),
    AGENT_CA_KEY: z.string().min(1).optional(),
    AGENT_CA_CHAIN: z.string().min(1).optional(),
    TASK_SIGNING_KEY: z.string().min(1).optional(),
    AGENT_CONTROL_URL: z.string().url().optional(),
    AGENT_INGEST_URL: z.string().url().optional(),
    AGENT_OPAMP_URL: z.string().url().optional(),
    AGENT_PROXY_ADDRESSES: z.string().optional(),
    INTERNAL_TOKEN: z.string().min(24).optional(),
    VM_QUERY_URL: z.string().url().optional(),
    /** Where tenant vmalert rule files are written (a volume vmalert reads), and vmalert's URL. */
    ALERT_RULES_DIR: z.string().min(1).optional(),
    VMALERT_URL: z.string().url().optional(),
    /** AI assistant (M14): platform providers; keys never reach the browser or the model. */
    AI_PROVIDER: z.enum(['gemini', 'groq', 'openrouter', 'openai']).optional(),
    AI_MODEL: z.string().min(1).optional(),
    AI_FALLBACK_PROVIDER: z.enum(['gemini', 'groq', 'openrouter', 'openai']).optional(),
    AI_FALLBACK_MODEL: z.string().min(1).optional(),
    GEMINI_API_KEY: z.string().min(10).optional(),
    GROQ_API_KEY: z.string().min(10).optional(),
    OPENROUTER_API_KEY: z.string().min(10).optional(),
    OPENAI_API_KEY: z.string().min(10).optional(),
    /** Tests and the e2e stack: a scripted provider instead of a real one. */
    PCP_AI_FAKE: z.enum(['0', '1']).optional(),
  })
  .refine(
    (c) =>
      [c.GOOGLE_CLIENT_ID, c.GOOGLE_CLIENT_SECRET, c.GOOGLE_REDIRECT_URI].every((v) => v === undefined) ||
      [c.GOOGLE_CLIENT_ID, c.GOOGLE_CLIENT_SECRET, c.GOOGLE_REDIRECT_URI].every((v) => v !== undefined),
    {
      message: 'set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI together',
      path: ['GOOGLE_CLIENT_ID'],
    },
  )
  .superRefine((c, issues) => {
    const set = AGENT_KEYS.filter((k) => c[k] !== undefined);
    if (set.length === 0 || set.length === AGENT_KEYS.length) return;
    for (const k of AGENT_KEYS.filter((k) => c[k] === undefined))
      issues.addIssue({ code: 'custom', path: [k], message: 'agent settings must be set together' });
  });

export interface AiProviderConfig {
  provider: 'gemini' | 'groq' | 'openrouter' | 'openai';
  model: string;
  apiKey: string;
}

export interface AiConfig {
  /** Primary first; empty when no provider is configured (AI endpoints answer 409). */
  providers: AiProviderConfig[];
  fake: boolean;
}

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface AgentConfig {
  caCertPem: string;
  caKeyPem: string;
  chainPem: string;
  taskSigningKeyPem: string;
  controlUrl: string;
  ingestUrl: string;
  opampUrl: string;
  /** Socket addresses allowed to send X-Client-Cert-Fingerprint (Caddy, D10). */
  proxyAddresses: string[];
}

export interface AppConfig {
  deploymentMode: 'managed' | 'self_hosted';
  bootstrapMode: 'private_http' | 'off';
  port: number;
  appOrigin: string;
  databaseUrl: string;
  redisUrl: string;
  smtpUrl?: string;
  /** Shown to customers who allowlist the platform (managed databases). */
  platformEgressIp?: string;
  mailFrom: string;
  google?: GoogleConfig;
  agents?: AgentConfig;
  /** Shared secret for private-network service calls; internal routes are off without it. */
  internalToken?: string;
  /** VictoriaMetrics base URL for reads (private network only, BR-04-05). */
  vmQueryUrl?: string;
  alertRulesDir?: string;
  vmalertUrl?: string;
  ai: AiConfig;
}

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
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
    bootstrapMode: c.BOOTSTRAP_MODE,
    port: c.API_PORT,
    appOrigin: new URL(c.APP_ORIGIN).origin,
    databaseUrl: c.DATABASE_URL,
    redisUrl: c.REDIS_URL,
    smtpUrl: c.SMTP_URL,
    platformEgressIp: c.PLATFORM_EGRESS_IP,
    mailFrom: c.MAIL_FROM,
    google: c.GOOGLE_CLIENT_ID
      ? {
          clientId: c.GOOGLE_CLIENT_ID,
          clientSecret: c.GOOGLE_CLIENT_SECRET!,
          redirectUri: c.GOOGLE_REDIRECT_URI!,
        }
      : undefined,
    internalToken: c.INTERNAL_TOKEN,
    vmQueryUrl: c.VM_QUERY_URL?.replace(/\/+$/, ''),
    alertRulesDir: c.ALERT_RULES_DIR,
    ai: aiConfig(c),
    vmalertUrl: c.VMALERT_URL?.replace(/\/+$/, ''),
    agents: c.AGENT_CA_CERT
      ? {
          caCertPem: fromBase64(c.AGENT_CA_CERT),
          caKeyPem: fromBase64(c.AGENT_CA_KEY!),
          chainPem: fromBase64(c.AGENT_CA_CHAIN!),
          taskSigningKeyPem: fromBase64(c.TASK_SIGNING_KEY!),
          controlUrl: c.AGENT_CONTROL_URL!,
          ingestUrl: c.AGENT_INGEST_URL!,
          opampUrl: c.AGENT_OPAMP_URL!,
          proxyAddresses: (c.AGENT_PROXY_ADDRESSES ?? '')
            .split(',')
            .map((a) => a.trim())
            .filter(Boolean),
        }
      : undefined,
  };
}

/** PEM values travel base64-encoded so they fit one environment-variable line. */
const fromBase64 = (v: string) => Buffer.from(v, 'base64').toString('utf8');

const AI_DEFAULT_MODEL = {
  gemini: 'gemini-2.5-flash',
  groq: 'openai/gpt-oss-120b',
  openrouter: 'openai/gpt-oss-120b',
  openai: 'gpt-4.1-mini',
};

function aiConfig(c: {
  AI_PROVIDER?: AiProviderConfig['provider'];
  AI_MODEL?: string;
  AI_FALLBACK_PROVIDER?: AiProviderConfig['provider'];
  AI_FALLBACK_MODEL?: string;
  GEMINI_API_KEY?: string;
  GROQ_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  OPENAI_API_KEY?: string;
  PCP_AI_FAKE?: '0' | '1';
}): AiConfig {
  const key = {
    gemini: c.GEMINI_API_KEY,
    groq: c.GROQ_API_KEY,
    openrouter: c.OPENROUTER_API_KEY,
    openai: c.OPENAI_API_KEY,
  };
  const providers: AiProviderConfig[] = [];
  for (const [provider, model] of [
    [c.AI_PROVIDER, c.AI_MODEL],
    [c.AI_FALLBACK_PROVIDER, c.AI_FALLBACK_MODEL],
  ] as const) {
    if (!provider) continue;
    const apiKey = key[provider];
    if (apiKey) providers.push({ provider, model: model ?? AI_DEFAULT_MODEL[provider], apiKey });
  }
  return { providers, fake: c.PCP_AI_FAKE === '1' };
}
