'use client';

import { useEffect, useRef, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Answer, type AnswerData } from './answer';
import { capitalize, toolLabel } from './tool-labels';

export interface AskHandlers {
  onEvent(event: string, data: unknown): void;
  onError(message: string): void;
  onClose(): void;
}

/** Starts one streamed investigation; returns a function that stops it. */
export type Ask = (content: string, handlers: AskHandlers) => () => void;

export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  evidence?: unknown;
  missing?: unknown;
  confidence?: string | null;
  validation?: string | null;
}

interface Step {
  evidenceId: string;
  tool: string;
  status: string;
}

type Turn = { question: string; steps: Step[]; answer: AnswerData | null; error: string | null };

const fromStored = (m: StoredMessage): AnswerData => ({
  text: m.content,
  evidence: (m.evidence ?? []) as AnswerData['evidence'],
  missing: (m.missing ?? []) as string[],
  confidence: (m.confidence ?? null) as AnswerData['confidence'],
  validation: (m.validation ?? null) as AnswerData['validation'],
});

/** A conversation (WB-14 UC-14-01): stored messages, then live turns streamed from the server. */
export function Chat({
  messages,
  ask,
  onDone,
  initialQuestion = '',
}: {
  messages: StoredMessage[];
  ask: Ask;
  onDone: () => void;
  initialQuestion?: string;
}) {
  const [question, setQuestion] = useState(initialQuestion);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);

  const update = (fn: (t: Turn) => Turn) => setTurns((all) => [...all.slice(0, -1), fn(all.at(-1)!)]);

  const submit = () => {
    const content = question.trim();
    if (!content || busy) return;
    setQuestion('');
    setBusy(true);
    setTurns((all) => [...all, { question: content, steps: [], answer: null, error: null }]);
    stop.current = ask(content, {
      onEvent(event, data) {
        if (event === 'tool') {
          const s = data as Step;
          update((t) => ({
            ...t,
            steps: t.steps.some((x) => x.evidenceId === s.evidenceId)
              ? t.steps.map((x) => (x.evidenceId === s.evidenceId ? s : x))
              : [...t.steps, s],
          }));
        } else if (event === 'answer') update((t) => ({ ...t, answer: data as AnswerData }));
        else if (event === 'error') {
          update((t) => ({
            ...t,
            error: (data as { message?: string }).message ?? 'The investigation failed.',
          }));
          setBusy(false);
        } else if (event === 'done') {
          setBusy(false);
          onDone();
        }
      },
      onError(message) {
        update((t) => ({ ...t, error: message }));
        setBusy(false);
      },
      onClose() {
        setBusy(false);
      },
    });
  };

  return (
    <div className="portal-chat space-y-4">
      {!messages.length && !turns.length && (
        <div className="portal-chat-welcome">
          <span className="portal-eyebrow">Product context</span>
          <h2>What would you like to understand?</h2>
          <p>Ask about a signal, a recent change, or the services your product depends on.</p>
          <div className="portal-question-suggestions">
            {['What needs attention?', 'What changed recently?', 'Why was the API slower?'].map((prompt) => (
              <button type="button" key={prompt} onClick={() => setQuestion(prompt)}>
                {prompt} ↗
              </button>
            ))}
          </div>
        </div>
      )}
      <ol className="space-y-4">
        {messages.map((m) => (
          <li
            key={m.id}
            className={m.role === 'user' ? 'font-medium' : 'rounded-lg border border-border bg-card p-4'}
          >
            {m.role === 'user' ? m.content : <Answer data={fromStored(m)} />}
          </li>
        ))}
        {turns.map((t, i) => (
          <li key={i} className="space-y-3">
            <p className="font-medium">{t.question}</p>
            {t.steps.length ? (
              <ul className="space-y-0.5 text-sm text-muted-foreground">
                {t.steps.map((s) => (
                  <li key={s.evidenceId}>
                    {s.status === 'running'
                      ? `Checking ${toolLabel(s.tool)}…`
                      : `${capitalize(s.status === 'ok' || s.status === 'truncated' ? 'checked' : 'could not check')} ${toolLabel(s.tool)}`}
                  </li>
                ))}
              </ul>
            ) : null}
            {t.error ? <Alert>{t.error}</Alert> : null}
            {t.answer ? (
              <div className="rounded-lg border border-border bg-card p-4">
                <Answer data={t.answer} />
              </div>
            ) : null}
          </li>
        ))}
      </ol>
      <div className="space-y-2">
        <label htmlFor="ai-question" className="text-sm font-medium">
          Ask about this product
        </label>
        <textarea
          id="ai-question"
          className="min-h-20 w-full rounded-md border border-border bg-background p-2 text-sm"
          placeholder="Why was it slow yesterday? Is anything wrong with vps-1?"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
          }}
        />
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            Answers use read-only tools on this product&apos;s data and cite their evidence. The assistant
            never changes anything.
          </p>
          <Button disabled={busy} onClick={submit}>
            {busy ? 'Investigating…' : 'Ask'}
          </Button>
        </div>
      </div>
    </div>
  );
}
