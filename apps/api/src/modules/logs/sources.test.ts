import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HOST_JOURNAL, PACK_LOG_SOURCES, logSources } from './sources.js';

const fixture = JSON.parse(
  readFileSync(
    new URL('../../../../../packages/agent-protocol/testdata/log-sources.json', import.meta.url),
    'utf8',
  ),
) as { packs: Record<string, string[]>; always: string[] };

describe('log sources', () => {
  it('match the agent allowlist through the shared fixture', () => {
    expect(Object.fromEntries([...PACK_LOG_SOURCES].map(([p, s]) => [p, s.map((x) => x.id)]))).toEqual(
      fixture.packs,
    );
    expect([HOST_JOURNAL.id]).toEqual(fixture.always);
  });

  it('always include the system journal last', () => {
    expect(logSources([]).map((s) => s.id)).toEqual(['host.journal']);
    expect(logSources(['nodejs', 'redis']).map((s) => s.id)).toEqual([
      'redis.server',
      'nodejs.journal',
      'host.journal',
    ]);
  });
});
