'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useParams, useSearchParams } from 'next/navigation';
import { useCallback, useRef, useState } from 'react';
import { unwrap } from '@pcp/api-client';
import { Chat, type Ask, type StoredMessage } from '@/components/ai/chat';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/cn';
import { QueryState } from '@/lib/page-guard';
import { openEventStream } from '@/lib/sse';
import { useApiQuery } from '@/lib/use-api-query';

export default function AiAssistantPage() {
  const { orgId, productId } = useParams<{ orgId: string; productId: string }>();
  const search = useSearchParams();
  const queryClient = useQueryClient();
  /** The conversation picked from the list (loads its messages; remounts the chat). */
  const [selected, setSelected] = useState<string | null>(null);
  /** The conversation questions go to; a first question creates it without remounting the chat. */
  const target = useRef<string | null>(null);
  /** Bumped on every pick, so "New conversation" clears the chat even when nothing was picked before. */
  const [session, setSession] = useState(0);
  const select = (id: string | null) => {
    target.current = id;
    setSelected(id);
    setSession((n) => n + 1);
  };
  const settings = useApiQuery(['ai-settings', orgId], async () =>
    unwrap(await api.GET('/api/v1/organizations/{orgId}/settings/ai', { params: { path: { orgId } } })),
  );
  const listKey = ['ai-conversations', productId];
  const conversations = useApiQuery(listKey, async () =>
    unwrap(await api.GET('/api/v1/products/{id}/ai/conversations', { params: { path: { id: productId } } })),
  );
  const conversation = useApiQuery(
    ['ai-conversation', selected],
    async () =>
      unwrap(await api.GET('/api/v1/ai/conversations/{id}', { params: { path: { id: selected! } } })),
    { enabled: Boolean(selected) },
  );

  const ask = useCallback<Ask>(
    (content, handlers) => {
      let stop = () => {};
      let stopped = false;
      void (async () => {
        try {
          let id = target.current;
          if (!id) {
            id = unwrap(
              await api.POST('/api/v1/products/{id}/ai/conversations', {
                params: { path: { id: productId } },
                body: { title: content.slice(0, 120) },
              }),
            ).id;
            target.current = id;
          }
          if (stopped) return;
          stop = openEventStream(`/api/v1/ai/conversations/${encodeURIComponent(id)}/messages`, {
            ...handlers,
            method: 'POST',
            body: { content },
          });
        } catch (e) {
          handlers.onError(errorMessage(e));
        }
      })();
      return () => {
        stopped = true;
        stop();
      };
    },
    [productId],
  );

  const s = settings.data;
  return (
    <section className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">AI Assistant</h1>
        <p className="text-sm text-muted-foreground">
          Ask about this product. Answers cite their evidence and list what could not be checked.
        </p>
      </div>
      {s && s.disabled ? (
        <Alert tone="info">The AI assistant is turned off for this organization.</Alert>
      ) : null}
      {s && !s.available ? <Alert tone="info">No AI provider is configured on this platform.</Alert> : null}
      <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
        <aside className="space-y-2">
          <Button size="sm" variant="outline" className="w-full" onClick={() => select(null)}>
            New conversation
          </Button>
          <QueryState query={conversations} label="Loading conversations">
            <ul className="space-y-1 text-sm">
              {(conversations.data?.conversations ?? []).map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => select(c.id)}
                    className={cn(
                      'w-full truncate rounded px-2 py-1 text-left hover:bg-muted',
                      (selected ?? target.current) === c.id && 'bg-muted font-medium',
                    )}
                  >
                    {c.title}
                  </button>
                </li>
              ))}
            </ul>
          </QueryState>
        </aside>
        <Chat
          key={`${selected ?? 'new'}-${session}`}
          messages={(conversation.data?.messages ?? []) as StoredMessage[]}
          ask={ask}
          initialQuestion={selected ? '' : (search.get('q') ?? '')}
          onDone={() => void queryClient.invalidateQueries({ queryKey: listKey })}
        />
      </div>
    </section>
  );
}
