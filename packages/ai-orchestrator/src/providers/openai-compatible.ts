import {
  ProviderError,
  type ChatMessage,
  type ChatProvider,
  type ChatRequest,
  type ToolCall,
} from './types.js';

export interface OpenAiCompatibleOptions {
  id: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
}

/** Known OpenAI-compatible endpoints (the user's Gemini and Groq keys, OpenRouter, OpenAI). */
export const PROVIDER_BASE_URLS: Record<string, string> = {
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  groq: 'https://api.groq.com/openai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  openai: 'https://api.openai.com/v1',
};

function wireMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  if (m.role === 'assistant' && m.toolCalls?.length)
    return {
      role: 'assistant',
      content: m.content,
      tool_calls: m.toolCalls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.arguments) },
      })),
    };
  return { role: m.role, content: m.content };
}

interface WireResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
    };
  }>;
}

/** Chat completions with tool calling over any OpenAI-compatible endpoint (M14.1). */
export function openAiCompatible(opts: OpenAiCompatibleOptions): ChatProvider {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const scrub = (s: string) => s.split(opts.apiKey).join('[key]');
  return {
    id: opts.id,
    model: opts.model,
    async chat(req: ChatRequest) {
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
      let res: Response;
      try {
        res = await fetch(`${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model: opts.model,
            messages: req.messages.map(wireMessage),
            ...(req.tools.length
              ? {
                  tools: req.tools.map((t) => ({
                    type: 'function',
                    function: { name: t.name, description: t.description, parameters: t.parameters },
                  })),
                  tool_choice: 'auto',
                }
              : {}),
          }),
          signal,
        });
      } catch (err) {
        const timedOut = timeout.aborted;
        throw new ProviderError(
          timedOut
            ? `${opts.id} timed out after ${timeoutMs} ms`
            : `${opts.id} unreachable: ${scrub(String(err))}`,
          true,
        );
      }
      const raw = await res.text();
      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        throw new ProviderError(
          `${opts.id} answered HTTP ${res.status}: ${scrub(raw).slice(0, 300)}`,
          retryable,
          res.status,
        );
      }
      let body: WireResponse;
      try {
        body = JSON.parse(raw) as WireResponse;
      } catch {
        throw new ProviderError(`${opts.id} sent a response that is not JSON`, true);
      }
      const message = body.choices?.[0]?.message ?? {};
      const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((c, i) => {
        const id = c.id ?? `call_${i}`;
        const name = c.function?.name ?? '';
        try {
          const args = JSON.parse(c.function?.arguments || '{}') as unknown;
          return {
            id,
            name,
            arguments: args && typeof args === 'object' ? (args as Record<string, unknown>) : {},
          };
        } catch {
          return { id, name, arguments: {}, error: 'arguments are not valid JSON' };
        }
      });
      return { ...(message.content ? { text: message.content } : {}), toolCalls };
    },
  };
}
