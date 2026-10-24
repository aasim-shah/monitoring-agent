import { chain } from './providers/chain.js';
import { openAiCompatible, PROVIDER_BASE_URLS } from './providers/openai-compatible.js';
import type { ChatProvider } from './providers/types.js';

/** `local`: any OpenAI-compatible endpoint the operator runs (Ollama, vLLM, LM Studio; M19.4). */
export type AiProviderName = 'gemini' | 'groq' | 'openrouter' | 'openai' | 'local';

export interface AiProviderConfig {
  provider: AiProviderName;
  model: string;
  apiKey: string;
  /** Only for `local`: the endpoint's /v1 base URL. */
  baseUrl?: string;
}

export interface AiConfig {
  /** Primary first; empty when no provider is configured. */
  providers: AiProviderConfig[];
  /** Tests and the e2e stack: a scripted provider instead of a real one (PCP_AI_FAKE=1). */
  fake: boolean;
  /** AI_DISABLED=1: the platform runs without any AI (self-hosted switch, M19.4). */
  disabled: boolean;
}

export const AI_DEFAULT_MODEL: Record<AiProviderName, string> = {
  gemini: 'gemini-2.5-flash',
  groq: 'openai/gpt-oss-120b',
  openrouter: 'openai/gpt-oss-120b',
  openai: 'gpt-4.1-mini',
  // No default: a local endpoint serves whatever models the operator pulled.
  local: '',
};

const NAMES = new Set<string>(Object.keys(AI_DEFAULT_MODEL));
const KEY_VAR: Record<AiProviderName, string> = {
  gemini: 'GEMINI_API_KEY',
  groq: 'GROQ_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  openai: 'OPENAI_API_KEY',
  local: 'AI_LOCAL_API_KEY',
};

/**
 * The platform's AI providers from AI_PROVIDER / AI_MODEL, AI_FALLBACK_PROVIDER /
 * AI_FALLBACK_MODEL, and the provider API keys (shared by the api and the worker). A provider
 * without its key is skipped; an unknown provider name throws.
 */
export function aiConfigFromEnv(env: Record<string, string | undefined>): AiConfig {
  const disabled = env.AI_DISABLED === '1';
  const providers: AiProviderConfig[] = [];
  if (disabled) return { providers, fake: false, disabled };
  for (const [nameVar, modelVar] of [
    ['AI_PROVIDER', 'AI_MODEL'],
    ['AI_FALLBACK_PROVIDER', 'AI_FALLBACK_MODEL'],
  ] as const) {
    const name = env[nameVar] || undefined;
    if (!name) continue;
    if (!NAMES.has(name)) throw new Error(`${nameVar} must be one of ${[...NAMES].join(', ')}`);
    const provider = name as AiProviderName;
    if (provider === 'local') {
      const baseUrl = env.AI_LOCAL_BASE_URL || undefined;
      if (!baseUrl)
        throw new Error(`${nameVar}=local needs AI_LOCAL_BASE_URL (for example http://ollama:11434/v1)`);
      const model = env[modelVar] || undefined;
      if (!model) throw new Error(`${nameVar}=local needs ${modelVar} (a model the endpoint serves)`);
      providers.push({ provider, model, apiKey: env.AI_LOCAL_API_KEY || 'none', baseUrl });
      continue;
    }
    const apiKey = env[KEY_VAR[provider]];
    if (apiKey) providers.push({ provider, model: env[modelVar] || AI_DEFAULT_MODEL[provider], apiKey });
  }
  return { providers, fake: env.PCP_AI_FAKE === '1', disabled };
}

/** Primary then fallback; null when no provider is configured. */
export function providerFromConfig(providers: AiProviderConfig[]): ChatProvider | null {
  const built = providers.map((p) =>
    openAiCompatible({
      id: p.provider,
      baseUrl: p.baseUrl ?? PROVIDER_BASE_URLS[p.provider]!,
      apiKey: p.apiKey,
      model: p.model,
    }),
  );
  if (built.length === 0) return null;
  return built.length === 1 ? built[0]! : chain(built);
}
