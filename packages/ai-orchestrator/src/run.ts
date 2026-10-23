import type { TenantContext } from '@pcp/shared-contracts';
import { executeTool, type Evidence } from './executor.js';
import { systemPrompt } from './prompt.js';
import { ProviderError, type ChatMessage, type ChatProvider } from './providers/types.js';
import { toolSchema, type Tool } from './tools.js';
import { validateAnswer } from './validate.js';

/** Master plan §3: AI run limits. */
export const RUN_LIMITS = { toolCalls: 12, runMs: 120_000 };

export type RunEvent =
  | { type: 'tool_started'; tool: string; evidenceId: string }
  | { type: 'tool_finished'; evidence: Evidence }
  | { type: 'answer'; text: string };

export interface RunResult {
  text: string;
  evidence: Evidence[];
  missing: string[];
  confidence: 'high' | 'medium' | 'low' | null;
  validation: 'verified' | 'unverified' | 'partial';
  problems: string[];
  toolCalls: number;
  provider: string | null;
}

export interface RunInput {
  provider: ChatProvider;
  tools: Tool[];
  ctx: TenantContext;
  question: string;
  history: ChatMessage[];
  productName: string;
  timezone: string;
  now: Date;
  deps: unknown;
  onEvent?: (e: RunEvent) => void;
  limits?: Partial<typeof RUN_LIMITS>;
}

const CONFIDENCE = /confidence:\s*(high|medium|low)/i;

/**
 * One investigation (spec §12, WB-14): the model calls tools, the executor answers with
 * evidence, and the final text is validated (citations exist, numbers come from evidence),
 * retried once, then marked unverified. Limits end the run with a partial answer.
 */
export async function runInvestigation(input: RunInput): Promise<RunResult> {
  const limits = { ...RUN_LIMITS, ...input.limits };
  const byName = new Map(input.tools.map((t) => [t.name, t]));
  const schemas = input.tools.map(toolSchema);
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt(input) },
    ...input.history,
    { role: 'user', content: input.question },
  ];
  const evidence: Evidence[] = [];
  const extraMissing: string[] = [];
  const deadline = Date.now() + limits.runMs;
  let toolCalls = 0;
  let retried = false;
  let limitHit = false;
  let provider: string | null = null;
  const missing = () => [...new Set([...evidence.flatMap((e) => e.gaps), ...extraMissing])];

  for (;;) {
    const timeLeft = deadline - Date.now();
    if (timeLeft <= 0 && !limitHit) {
      limitHit = true;
      extraMissing.push('Investigation incomplete: the 120 s time limit was reached');
    }
    let res;
    try {
      res = await input.provider.chat({
        messages,
        tools: limitHit ? [] : schemas,
        signal: AbortSignal.timeout(Math.max(timeLeft, 30_000)),
      });
    } catch (err) {
      const message = err instanceof ProviderError ? err.message : 'AI provider unavailable';
      const text = `${/AI provider unavailable/.test(message) ? message : `AI provider unavailable: ${message}`}. The evidence gathered so far is listed below.`;
      input.onEvent?.({ type: 'answer', text });
      return {
        text,
        evidence,
        missing: missing(),
        confidence: null,
        validation: 'partial',
        problems: [],
        toolCalls,
        provider,
      };
    }
    provider = res.provider ?? input.provider.id;

    if (res.toolCalls.length && !limitHit) {
      messages.push({ role: 'assistant', content: res.text ?? '', toolCalls: res.toolCalls });
      for (const call of res.toolCalls) {
        if (toolCalls >= limits.toolCalls) {
          limitHit = true;
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            content: JSON.stringify({ error: 'tool call limit reached; answer with the evidence you have' }),
          });
          continue;
        }
        toolCalls++;
        const id = `E${evidence.length + 1}`;
        input.onEvent?.({ type: 'tool_started', tool: call.name, evidenceId: id });
        const ev = call.error
          ? await executeTool(undefined, call.name, input.ctx, {}, input.deps, id).then((e) => ({
              ...e,
              gaps: [`${call.name}: ${call.error}`],
            }))
          : await executeTool(byName.get(call.name), call.name, input.ctx, call.arguments, input.deps, id);
        evidence.push(ev);
        input.onEvent?.({ type: 'tool_finished', evidence: ev });
        messages.push({ role: 'tool', toolCallId: call.id, content: ev.json });
      }
      if (limitHit)
        extraMissing.push(`Investigation incomplete: the ${limits.toolCalls} tool-call limit was reached`);
      continue;
    }

    const text = res.text?.trim() || 'No answer was produced.';
    const check = validateAnswer(text, evidence, input.question);
    if (!check.ok && !retried && !limitHit) {
      retried = true;
      messages.push({ role: 'assistant', content: text });
      messages.push({
        role: 'user',
        content:
          `Your answer failed validation: ${check.problems.join('; ')}. ` +
          'Rewrite it using only evidence IDs that exist and numbers exactly as they appear in the tool results.',
      });
      continue;
    }
    input.onEvent?.({ type: 'answer', text });
    const confidence = (CONFIDENCE.exec(text)?.[1]?.toLowerCase() ?? null) as RunResult['confidence'];
    return {
      text,
      evidence,
      missing: missing(),
      confidence,
      validation: limitHit ? 'partial' : check.ok ? 'verified' : 'unverified',
      problems: check.problems,
      toolCalls,
      provider,
    };
  }
}
