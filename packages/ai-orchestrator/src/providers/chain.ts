import { ProviderError, type ChatProvider, type ChatRequest, type ChatResponse } from './types.js';

/** Primary then fallbacks: a retryable failure moves on; a request error (400) does not (Review Focus #3). */
export function chain(providers: ChatProvider[]): ChatProvider {
  const [first] = providers;
  if (!first) throw new Error('chain needs at least one provider');
  return {
    id: providers.map((p) => p.id).join('>'),
    model: first.model,
    async chat(req: ChatRequest): Promise<ChatResponse> {
      const failures: string[] = [];
      for (const p of providers) {
        try {
          return { ...(await p.chat(req)), provider: p.id };
        } catch (err) {
          if (err instanceof ProviderError && !err.retryable) throw err;
          failures.push(err instanceof Error ? err.message : String(err));
        }
      }
      throw new ProviderError(`AI provider unavailable (${failures.join('; ')})`, true);
    },
  };
}
