/** A log source the viewer may tail; requests carry the ID only, the agent owns the paths. */
export interface LogSource {
  id: string;
  label: string;
}

/**
 * Mirrors the agent allowlist (agents/host-agent-go/internal/logs/sources.go); both are pinned
 * to packages/agent-protocol/testdata/log-sources.json. Order is display order.
 */
const PACK_SOURCES: [pack: string, sources: LogSource[]][] = [
  ['redis', [{ id: 'redis.server', label: 'Redis server log' }]],
  ['postgresql', [{ id: 'postgresql.main', label: 'PostgreSQL log' }]],
  ['mysql', [{ id: 'mysql.error', label: 'MySQL error log' }]],
  ['mongodb', [{ id: 'mongodb.main', label: 'MongoDB log' }]],
  ['kafka', [{ id: 'kafka.server', label: 'Kafka server log' }]],
  [
    'nginx',
    [
      { id: 'nginx.access', label: 'nginx access log' },
      { id: 'nginx.error', label: 'nginx error log' },
    ],
  ],
  ['nodejs', [{ id: 'nodejs.journal', label: 'Node.js processes (journal)' }]],
];

export const HOST_JOURNAL: LogSource = { id: 'host.journal', label: 'System journal' };

export const PACK_LOG_SOURCES: ReadonlyMap<string, LogSource[]> = new Map(PACK_SOURCES);

/** What may be tailed on an agent with these applied packs, plus the system journal. */
export function logSources(appliedPacks: Iterable<string>): LogSource[] {
  const have = new Set(appliedPacks);
  return [...PACK_SOURCES.filter(([pack]) => have.has(pack)).flatMap(([, s]) => s), HOST_JOURNAL];
}
