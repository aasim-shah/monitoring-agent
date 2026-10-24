import { validateAnswer, type ChatMessage, type ChatProvider } from '@pcp/ai-orchestrator';
import type { Snapshot } from './snapshot.js';

export type NarrativeStatus = 'verified' | 'deferred' | 'disabled';

const SECTION_CITATION = /\[(S\d+)\]/g;

const SYSTEM = [
  'You write the executive summary of a daily product operations report.',
  'Use only the numbers in the sections below; never compute, estimate, or round differently.',
  'Cite every claim with its section ID in square brackets, for example [S3].',
  'Write 3 to 6 plain sentences. Say "correlated with", never that one thing caused another.',
  'Mention sections with status "missing" only as missing data.',
  'Name the largest changes of the day: rows added to databases, website speed and uptime, and Google',
  'figures, giving the value and its "previous" value as written, never a percentage.',
].join(' ');

/** What the model sees: section titles, status, and the snapshot's numbers. Nothing raw (BR-15-02). */
export function summarize(snapshot: Snapshot): string {
  const lines = snapshot.sections.map(
    (s) =>
      `[${s.id}] ${s.title} (${s.status})${s.reason ? `: ${s.reason}` : ''}${s.data === null ? '' : `\n${JSON.stringify(s.data)}`}`,
  );
  return `Report day ${snapshot.window.localDate} (${snapshot.window.timezone}, ${snapshot.window.hours} h).\n\n${lines.join('\n\n')}`;
}

/**
 * The AI executive summary (spec §13.3 G–H). Every number and `[S#]` citation must match the
 * snapshot (BR-15-03); after one failed retry, or when the provider fails, the narrative is
 * deferred and the deterministic report goes out without it (UC-15-05).
 */
export async function narrate(
  snapshot: Snapshot,
  provider: ChatProvider | null,
  opts: { disabled: boolean },
): Promise<{ text: string | null; status: NarrativeStatus; problems: string[] }> {
  if (opts.disabled || !provider) return { text: null, status: 'disabled', problems: [] };
  const evidence = snapshot.sections.map((s) => ({
    id: s.id,
    json: JSON.stringify({ window: snapshot.window, title: s.title, data: s.data, reason: s.reason }),
  }));
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: summarize(snapshot) },
  ];
  let problems: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    let text: string;
    try {
      text = (await provider.chat({ messages, tools: [] })).text?.trim() ?? '';
    } catch (err) {
      return {
        text: null,
        status: 'deferred',
        problems: [`AI provider unavailable: ${(err as Error).message}`.slice(0, 300)],
      };
    }
    const check = validateAnswer(text, evidence, '', { citation: SECTION_CITATION });
    if (text && check.ok) return { text, status: 'verified', problems: [] };
    problems = text ? check.problems : ['The AI returned no summary'];
    messages.push(
      { role: 'assistant', content: text },
      {
        role: 'user',
        content: `These claims failed validation: ${problems.join('; ')}. Rewrite the summary using only numbers from the sections, each cited.`,
      },
    );
  }
  return { text: null, status: 'deferred', problems };
}
