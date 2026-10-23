import { ProviderError, type ChatProvider, type ChatRequest, type ToolCall } from './types.js';

export type ScriptStep =
  | { text: string; toolCalls?: never; error?: never }
  | { toolCalls: Array<Omit<ToolCall, 'id'> & { id?: string }>; text?: string; error?: never }
  | { error: { status: number; message?: string }; text?: never; toolCalls?: never };

/**
 * A provider that replays recorded steps in order (tests and the e2e stack, PCP_AI_FAKE=1).
 * Every request is kept so tests can inspect what the model would have seen.
 */
export function scripted(id: string, steps: ScriptStep[] | ((req: ChatRequest, turn: number) => ScriptStep)) {
  const requests: ChatRequest[] = [];
  const provider: ChatProvider & { requests: ChatRequest[] } = {
    id,
    model: `${id}-scripted`,
    requests,
    async chat(req) {
      requests.push(structuredClone({ ...req, signal: undefined }));
      const turn = requests.length - 1;
      const step = typeof steps === 'function' ? steps(req, turn) : steps[Math.min(turn, steps.length - 1)];
      if (!step) throw new ProviderError(`${id}: no scripted step ${turn}`, false);
      if (step.error)
        throw new ProviderError(
          `${id} answered HTTP ${step.error.status}`,
          step.error.status === 429 || step.error.status >= 500,
          step.error.status,
        );
      return {
        ...(step.text ? { text: step.text } : {}),
        toolCalls: (step.toolCalls ?? []).map((c, i) => ({ id: c.id ?? `call_${turn}_${i}`, ...c })),
      };
    },
  };
  return provider;
}
