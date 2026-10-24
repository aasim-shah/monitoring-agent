import { aiConfigFromEnv, type AiConfig } from '@pcp/ai-orchestrator';
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
    PLATFORM_EGRESS_IP: z.union([z.ipv4(), z.ipv6()]).optional(),
    GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
    GOOGLE_REDIRECT_URI: z.string().url().optional(),
    /** Google data connections (M13b) return here; needs the client above (BR-08-01: never the sign-in redirect). */
    GOOGLE_CONNECTIONS_REDIRECT_URI: z.string().url().optional(),
    /** Test stacks only, with PCP_ALLOW_TEST_PROVIDERS=1: a fake Google (token exchange). */
    PCP_GOOGLE_API_URL: z.string().url().optional(),
    PCP_ALLOW_TEST_PROVIDERS: z.enum(['0', '1']).optional(),
    AGENT_CA_CERT: z.string().min(1).optional(),
    AGENT_CA_KEY: z.string().min(1).optional(),
    AGENT_CA_CHAIN: z.string().min(1).optional(),
    TASK_SIGNING_KEY: z.string().min(1).optional(),
    AGENT_CONTROL_URL: z.string().url().optional(),
    AGENT_INGEST_URL: z.string().url().optional(),
    AGENT_OPAMP_URL: z.string().url().optional(),
    AGENT_PROXY_ADDRESSES: z.string().optional(),
    INTERNAL_TOKEN: z.string().min(24).optional(),
    /** Assisted SSH install (M17.3): the runner's internal URL and the egress IPs customers allowlist. */
    INSTALLER_RUNNER_URL: z.string().url().optional(),
    INSTALLER_EGRESS_IPS: z.string().optional(),
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
  .refine((c) => !c.GOOGLE_CONNECTIONS_REDIRECT_URI || c.GOOGLE_CLIENT_ID, {
    message: 'GOOGLE_CONNECTIONS_REDIRECT_URI needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET',
    path: ['GOOGLE_CONNECTIONS_REDIRECT_URI'],
  })
  .refine((c) => !c.PCP_GOOGLE_API_URL || c.PCP_ALLOW_TEST_PROVIDERS === '1', {
    message: 'PCP_GOOGLE_API_URL is for test stacks only and needs PCP_ALLOW_TEST_PROVIDERS=1',
    path: ['PCP_GOOGLE_API_URL'],
  })
  .superRefine((c, issues) => {
    const set = AGENT_KEYS.filter((k) => c[k] !== undefined);
    if (set.length === 0 || set.length === AGENT_KEYS.length) return;
    for (const k of AGENT_KEYS.filter((k) => c[k] === undefined))
      issues.addIssue({ code: 'custom', path: [k], message: 'agent settings must be set together' });
  });

export type { AiConfig, AiProviderConfig } from '@pcp/ai-orchestrator';

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Google data connections (M13b): their own redirect, and the token endpoint. */
  connections?: { redirectUri: string; tokenUrl: string };
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
  installer?: { runnerUrl?: string; egressIps: string[] };
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
          ...(c.GOOGLE_CONNECTIONS_REDIRECT_URI
            ? {
                connections: {
                  redirectUri: c.GOOGLE_CONNECTIONS_REDIRECT_URI,
                  tokenUrl: c.PCP_GOOGLE_API_URL
                    ? `${c.PCP_GOOGLE_API_URL.replace(/\/+$/, '')}/oauth2.googleapis.com/token`
                    : 'https://oauth2.googleapis.com/token',
                },
              }
            : {}),
        }
      : undefined,
    internalToken: c.INTERNAL_TOKEN,
    installer: {
      runnerUrl: c.INSTALLER_RUNNER_URL?.replace(/\/+$/, ''),
      egressIps: (c.INSTALLER_EGRESS_IPS ?? '')
        .split(',')
        .map((ip) => ip.trim())
        .filter(Boolean),
    },
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

/** Shared with the worker (reports): primary and fallback providers with their keys. */
const aiConfig = (c: Record<string, unknown>): AiConfig =>
  aiConfigFromEnv(
    Object.fromEntries(Object.entries(c).map(([k, v]) => [k, typeof v === 'string' ? v : undefined])),
  );
