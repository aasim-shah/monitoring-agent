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
    });
  });

  it('skips a provider without its key, treats empty values as unset, and refuses unknown names', () => {
    expect(aiConfigFromEnv({ AI_PROVIDER: 'openai', AI_FALLBACK_PROVIDER: '', PCP_AI_FAKE: '1' })).toEqual({
      providers: [],
      fake: true,
    });
    expect(() => aiConfigFromEnv({ AI_PROVIDER: 'anthropicx' })).toThrow(/AI_PROVIDER must be one of/);
    expect(providerFromConfig([])).toBeNull();
    expect(providerFromConfig([{ provider: 'gemini', model: 'm', apiKey: 'k' }])?.id).toBe('gemini');
  });
});
