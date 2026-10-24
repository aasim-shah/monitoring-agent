import { describe, expect, it } from 'vitest';
import { aiConfigFromEnv, providerFromConfig } from './env.js';

describe('aiConfigFromEnv', () => {
  it('reads the primary and fallback providers with default models', () => {
    expect(
      aiConfigFromEnv({
        AI_PROVIDER: 'gemini',
        AI_FALLBACK_PROVIDER: 'groq',
        AI_FALLBACK_MODEL: 'llama-x',
        GEMINI_API_KEY: 'g-key-123456',
        GROQ_API_KEY: 'q-key-123456',
      }),
    ).toEqual({
      providers: [
        { provider: 'gemini', model: 'gemini-2.5-flash', apiKey: 'g-key-123456' },
        { provider: 'groq', model: 'llama-x', apiKey: 'q-key-123456' },
      ],
      fake: false,
      disabled: false,
    });
  });

  it('M19.4: a local OpenAI-compatible endpoint needs a base URL and model, not a key', () => {
    const cfg = aiConfigFromEnv({
      AI_PROVIDER: 'local',
      AI_MODEL: 'llama3.1:8b',
      AI_LOCAL_BASE_URL: 'http://ollama:11434/v1',
    });
    expect(cfg.providers).toEqual([
      { provider: 'local', model: 'llama3.1:8b', apiKey: 'none', baseUrl: 'http://ollama:11434/v1' },
    ]);
    expect(providerFromConfig(cfg.providers)?.id).toBe('local');
    expect(() => aiConfigFromEnv({ AI_PROVIDER: 'local', AI_MODEL: 'm' })).toThrow(/AI_LOCAL_BASE_URL/);
    expect(() => aiConfigFromEnv({ AI_PROVIDER: 'local', AI_LOCAL_BASE_URL: 'http://x/v1' })).toThrow(
      /AI_MODEL/,
    );
  });

  it('M19.4: AI_DISABLED turns every provider off', () => {
    expect(
      aiConfigFromEnv({ AI_DISABLED: '1', AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'g-key-123456' }),
    ).toEqual({
      providers: [],
      fake: false,
      disabled: true,
    });
  });

  it('skips a provider without its key, treats empty values as unset, and refuses unknown names', () => {
    expect(aiConfigFromEnv({ AI_PROVIDER: 'openai', AI_FALLBACK_PROVIDER: '', PCP_AI_FAKE: '1' })).toEqual({
      providers: [],
      fake: true,
      disabled: false,
    });
    expect(() => aiConfigFromEnv({ AI_PROVIDER: 'anthropicx' })).toThrow(/AI_PROVIDER must be one of/);
    expect(providerFromConfig([])).toBeNull();
    expect(providerFromConfig([{ provider: 'gemini', model: 'm', apiKey: 'k' }])?.id).toBe('gemini');
  });
});
