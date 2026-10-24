/**
 * Fixed PromQL for host charts (metric names verified against pcp-otelcol, see the
 * M6.1 handoff). Users never send PromQL in M6a; scope filters are added by the query service.
 */
export const RANGES = {
  '15m': { seconds: 900, step: 30 },
  '1h': { seconds: 3600, step: 60 },
  '6h': { seconds: 6 * 3600, step: 300 },
  '24h': { seconds: 86400, step: 900 },
  '7d': { seconds: 7 * 86400, step: 3600 },
  // Beyond raw retention (15 days) these read the 5-minute rollups when they are on (M18.4).
  '30d': { seconds: 30 * 86400, step: 3 * 3600 },
  '90d': { seconds: 90 * 86400, step: 6 * 3600 },
} as const;
export type RangeKey = keyof typeof RANGES;

export const HOST_QUERIES = {
  cpu: '100 * (1 - avg(system_cpu_utilization_ratio{state="idle"}))',
  memory: '100 * avg(system_memory_utilization_ratio{state="used"})',
  disk: '100 * max by (mountpoint) (system_filesystem_utilization_ratio)',
  networkIn: 'sum(rate(system_network_io_bytes_total{direction="receive",device!="lo"}[5m]))',
  networkOut: 'sum(rate(system_network_io_bytes_total{direction="transmit",device!="lo"}[5m]))',
} as const;

/** Current usage per host for the infrastructure list (instant queries, grouped by agent). */
export const FLEET_QUERIES = {
  cpu: '100 * (1 - avg by (agent_id) (system_cpu_utilization_ratio{state="idle"}))',
  memory: '100 * avg by (agent_id) (system_memory_utilization_ratio{state="used"})',
  disk: '100 * max by (agent_id) (system_filesystem_utilization_ratio)',
  lastSample: 'max by (agent_id) (timestamp(system_cpu_utilization_ratio{state="idle"}))',
} as const;
