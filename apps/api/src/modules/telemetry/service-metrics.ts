/**
 * Fixed PromQL for monitoring-pack charts (WB-11). Names follow the collector's
 * remote_write translation: unit suffixes (`_bytes`), `_total` for monotonic sums, and
 * `_ratio` for unit-1 gauges. Redis and PostgreSQL are verified end to end (M6b Task 6);
 * the others follow the receivers' metadata for v0.162.0. Scope filters are added by the
 * query service; users never send PromQL.
 */
export type ChartUnit = 'bytes' | 'percent' | 'count' | 'perSecond';

export interface ChartTemplate {
  key: string;
  title: string;
  unit: ChartUnit;
  promql: string;
  /** Builds a series label from its Prometheus labels; one unlabelled series when absent. */
  label?: (labels: Record<string, string>) => string;
}

const byDatabase = (l: Record<string, string>) => l.db_namespace || 'all databases';
const byProcess = (l: Record<string, string>) =>
  `${l.process_executable_name || 'process'} (pid ${l.process_pid ?? '?'})`;

/**
 * Error lines per minute from the pack's log files (M11.2 count connector). A counter only
 * appears with its first lines, so MetricsQL `increase_pure` (counters start at 0) is used:
 * `rate` would drop the first burst. 0 while lines are counted but none are errors; a gap
 * when nothing is counted (no zeros without data).
 */
const logErrors = (pack: string): ChartTemplate => {
  const lines = `{__name__=~"log_lines(_total)?",service="${pack}"`;
  return {
    key: 'logErrors',
    title: 'Log errors per minute',
    unit: 'count',
    promql: `(sum(increase_pure(${lines},level="error"}[5m])) / 5) or (sum(increase_pure(${lines}}[5m])) * 0)`,
  };
};

export const SERVICE_CHARTS: Record<string, ChartTemplate[]> = {
  redis: [
    { key: 'memory', title: 'Memory used', unit: 'bytes', promql: 'sum(redis_memory_used_bytes)' },
    {
      key: 'ops',
      title: 'Commands per second',
      unit: 'perSecond',
      promql: 'sum(rate(redis_commands_processed_total[5m]))',
    },
    { key: 'clients', title: 'Connected clients', unit: 'count', promql: 'sum(redis_clients_connected)' },
    {
      key: 'hitRatio',
      title: 'Keyspace hit ratio',
      unit: 'percent',
      // No reads in the window divides by zero: a gap, not 0 %.
      promql:
        '100 * sum(rate(redis_keyspace_hits_total[5m])) / (sum(rate(redis_keyspace_hits_total[5m])) + sum(rate(redis_keyspace_misses_total[5m])))',
    },
    logErrors('redis'),
  ],
  postgresql: [
    { key: 'connections', title: 'Connections', unit: 'count', promql: 'sum(postgresql_backends)' },
    {
      key: 'commits',
      title: 'Commits per second',
      unit: 'perSecond',
      promql: 'sum(rate(postgresql_commits_total[5m]))',
    },
    {
      key: 'size',
      title: 'Database size',
      unit: 'bytes',
      promql: 'sum by (db_namespace) (postgresql_db_size_bytes)',
      label: byDatabase,
    },
    logErrors('postgresql'),
  ],
  mysql: [
    {
      key: 'connections',
      title: 'Connected threads',
      unit: 'count',
      promql: 'sum(mysql_threads{kind="connected"})',
    },
    {
      key: 'queries',
      title: 'Operations per second',
      unit: 'perSecond',
      promql: 'sum(rate(mysql_operations_total[5m]))',
    },
    logErrors('mysql'),
  ],
  mongodb: [
    {
      key: 'connections',
      title: 'Current connections',
      unit: 'count',
      promql: 'sum(mongodb_connection_count{type="current"})',
    },
    {
      key: 'operations',
      title: 'Operations per second',
      unit: 'perSecond',
      promql: 'sum(rate(mongodb_operation_count_total[5m]))',
    },
    logErrors('mongodb'),
  ],
  nginx: [
    {
      key: 'requests',
      title: 'Requests per second',
      unit: 'perSecond',
      promql: 'sum(rate(nginx_requests_total[5m]))',
    },
    {
      key: 'active',
      title: 'Active connections',
      unit: 'count',
      promql: 'sum(nginx_connections_current{state="active"})',
    },
    logErrors('nginx'),
  ],
  kafka: [
    {
      key: 'lag',
      title: 'Consumer lag',
      unit: 'count',
      promql: 'sum by (group) ({__name__=~"kafka_consumer_group_lag(_ratio)?"})',
      label: (l) => l.group || 'all groups',
    },
    { key: 'partitions', title: 'Partitions', unit: 'count', promql: 'sum(kafka_topic_partitions)' },
    logErrors('kafka'),
  ],
  nodejs: [
    {
      key: 'cpu',
      title: 'CPU per process',
      unit: 'percent',
      promql:
        '100 * sum by (process_pid, process_executable_name) ({__name__=~"process_cpu_utilization(_ratio)?",process_executable_name=~"node|nodejs"})',
      label: byProcess,
    },
    {
      key: 'memory',
      title: 'Memory per process',
      unit: 'bytes',
      promql:
        'sum by (process_pid, process_executable_name) (process_memory_usage_bytes{process_executable_name=~"node|nodejs"})',
      label: byProcess,
    },
  ],
};
