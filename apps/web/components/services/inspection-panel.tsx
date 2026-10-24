'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { errorMessage } from '@/lib/api';

export interface InspectionSettings {
  enabled: boolean;
  redisKeys: string[];
  peekTopics: string[];
}

export interface InspectionView {
  id: string;
  status: string;
  result: unknown;
  error: string | null;
  expired?: boolean;
}

export interface InspectionApi {
  configure(settings: Partial<InspectionSettings>): Promise<InspectionSettings>;
  request(body: {
    packId: string;
    target: 'redis' | 'kafka' | 'kafka_peek';
    topic?: string;
    reason?: string;
  }): Promise<{
    id: string;
  }>;
  get(id: string): Promise<InspectionView>;
}

interface RedisResult {
  info: Record<string, string>;
  dbSize: number;
  clients: number;
  slowlog: Array<{ id: number; command: string; durationMicros: number }>;
  keys: Array<{ key: string; type: string; length: number; memoryBytes: number }>;
}

interface KafkaResult {
  brokers: number;
  topics: Array<{ name: string; partitions: number; retentionMs: number | null; sizeBytes: number | null }>;
  groups: Array<{ name: string; state: string; members: number; lag: number }>;
}

type Message = { partition: number; offset: number; at: number; key: string; value: string };

const lines = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

const bytes = (n: number | null | undefined) =>
  n == null ? '—' : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`;

function RedisStats({ r }: { r: RedisResult }) {
  const hits = Number(r.info.keyspace_hits ?? 0);
  const misses = Number(r.info.keyspace_misses ?? 0);
  return (
    <div className="space-y-2 text-sm">
      <p className="flex flex-wrap gap-x-4">
        <span>{`${r.dbSize} keys`}</span>
        <span>{`${r.clients} clients`}</span>
        <span>{bytes(Number(r.info.used_memory))} used</span>
        {hits + misses > 0 ? <span>{`${Math.round((hits / (hits + misses)) * 100)}% hit ratio`}</span> : null}
        {r.info.redis_version ? <span>Redis {r.info.redis_version}</span> : null}
      </p>
      {r.keys.length ? (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th>Key</th>
              <th>Type</th>
              <th>Length</th>
              <th>Memory</th>
            </tr>
          </thead>
          <tbody>
            {r.keys.map((k) => (
              <tr key={k.key} aria-label={`${k.key} ${k.type} ${k.length}`}>
                <td className="font-mono">{k.key}</td>
                <td>{k.type}</td>
                <td>{k.length}</td>
                <td>{bytes(k.memoryBytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {r.slowlog.length ? (
        <div>
          <p className="text-xs font-medium">Slow commands (names only)</p>
          <ul className="text-xs">
            {r.slowlog.map((e) => (
              <li key={e.id}>{`${e.command} · ${Math.round(e.durationMicros / 1000)} ms`}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function KafkaStats({ k }: { k: KafkaResult }) {
  return (
    <div className="space-y-2 text-xs">
      <p className="text-sm">{`${k.brokers} broker${k.brokers === 1 ? '' : 's'}, ${k.topics.length} topics`}</p>
      <table className="w-full">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th>Topic</th>
            <th>Partitions</th>
            <th>Size</th>
            <th>Retention</th>
          </tr>
        </thead>
        <tbody>
          {k.topics.map((t) => (
            <tr key={t.name}>
              <td className="font-mono">{t.name}</td>
              <td>{t.partitions}</td>
              <td>{bytes(t.sizeBytes)}</td>
              <td>{t.retentionMs == null ? '—' : `${Math.round(t.retentionMs / 3_600_000)} h`}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {k.groups.length ? (
        <table className="w-full">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th>Consumer group</th>
              <th>State</th>
              <th>Members</th>
              <th>Lag</th>
            </tr>
          </thead>
          <tbody>
            {k.groups.map((g) => (
              <tr key={g.name}>
                <td className="font-mono">{g.name}</td>
                <td>{g.state}</td>
                <td>{g.members}</td>
                <td>{g.lag}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

/**
 * Data inspection for the Redis and Kafka packs (spec §11.9): statistics, not data. Off by default;
 * owners and admins turn it on and allowlist exact keys and peek topics. Everything is audited.
 */
export function InspectionPanel({
  name,
  packId,
  settings: initial,
  canConfigure,
  canRun,
  api,
  pollMs = 1500,
}: {
  name: string;
  packId: 'redis' | 'kafka';
  settings: InspectionSettings;
  canConfigure: boolean;
  canRun: boolean;
  api: InspectionApi;
  pollMs?: number;
}) {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState(initial);
  const [list, setList] = useState((packId === 'redis' ? initial.redisKeys : initial.peekTopics).join('\n'));
  const [result, setResult] = useState<InspectionView | null>(null);
  const [peekTopic, setPeekTopic] = useState(initial.peekTopics[0] ?? '');
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (body: Parameters<InspectionApi['request']>[0]) => {
    setError(null);
    setPending(true);
    setResult(null);
    try {
      const { id } = await api.request(body);
      for (let i = 0; i < 40; i++) {
        const view = await api.get(id);
        if (view.status !== 'queued') {
          setResult(view);
          break;
        }
        if (pollMs > 0) await new Promise((r) => setTimeout(r, pollMs));
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  };

  const save = async (enabled: boolean) => {
    setError(null);
    try {
      const names = lines(list);
      setSettings(
        await api.configure(
          packId === 'redis' ? { enabled, redisKeys: names } : { enabled, peekTopics: names },
        ),
      );
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const peekResult = Array.isArray(result?.result) ? (result!.result as Message[]) : null;
  return (
    <div className="rounded-md border border-border">
      <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen(!open)}>
        Data inspection
      </Button>
      {open ? (
        <div className="space-y-3 p-3">
          {error ? <Alert>{error}</Alert> : null}
          {!settings.enabled ? (
            <p className="text-sm text-muted-foreground">
              Off. Inspection reads statistics about {name} (counts and sizes), never values, with read-only
              commands, and every use is audited. {canConfigure ? null : 'An owner or admin can turn it on.'}
            </p>
          ) : null}
          {canConfigure ? (
            <div className="space-y-2">
              <Field
                id={`inspect-list-${packId}`}
                label={
                  packId === 'redis'
                    ? 'Keys to watch (exact names, one per line)'
                    : 'Topics allowed for message peek (exact names, one per line)'
                }
              >
                <textarea
                  id={`inspect-list-${packId}`}
                  className="min-h-16 w-full rounded-md border border-border bg-background p-2 font-mono text-xs"
                  value={list}
                  onChange={(e) => setList(e.target.value)}
                />
              </Field>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => save(true)}>
                  {settings.enabled ? 'Save' : 'Turn on'}
                </Button>
                {settings.enabled ? (
                  <Button size="sm" variant="outline" onClick={() => save(false)}>
                    Turn off
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
          {settings.enabled && canRun ? (
            <div className="space-y-3">
              <Button size="sm" disabled={pending} onClick={() => run({ packId, target: packId })}>
                Inspect now
              </Button>
              {packId === 'kafka' && settings.peekTopics.length ? (
                <div className="space-y-2 rounded-md border border-border p-2">
                  <Field id="peek-topic" label="Topic">
                    <select
                      id="peek-topic"
                      className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
                      value={peekTopic}
                      onChange={(e) => setPeekTopic(e.target.value)}
                    >
                      {settings.peekTopics.map((t) => (
                        <option key={t}>{t}</option>
                      ))}
                    </select>
                  </Field>
                  <Field id="peek-reason" label="Reason (audited)">
                    <Input id="peek-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
                  </Field>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending || reason.trim().length < 3}
                    onClick={() =>
                      run({ packId, target: 'kafka_peek', topic: peekTopic, reason: reason.trim() })
                    }
                  >
                    Peek 20 latest messages
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
          {pending ? <p className="animate-pulse text-xs text-muted-foreground">Asking the agent…</p> : null}
          {result?.status === 'failed' ? <Alert>{result.error ?? 'The inspection failed'}</Alert> : null}
          {result?.expired ? (
            <p className="text-xs text-muted-foreground">These messages are no longer available.</p>
          ) : null}
          {result?.status === 'succeeded' && peekResult ? (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">
                Redacted on the server; shown for 10 minutes, not stored.
              </p>
              <ul className="space-y-1">
                {peekResult.map((m) => (
                  <li key={`${m.partition}-${m.offset}`} className="rounded bg-muted p-2 font-mono text-xs">
                    <span className="text-muted-foreground">{`p${m.partition}@${m.offset} `}</span>
                    <span>{m.value}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {result?.status === 'succeeded' && !peekResult && packId === 'redis' ? (
            <RedisStats r={result.result as RedisResult} />
          ) : null}
          {result?.status === 'succeeded' && !peekResult && packId === 'kafka' ? (
            <KafkaStats k={result.result as KafkaResult} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
