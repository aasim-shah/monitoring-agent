import type { ReportSources } from './snapshot.js';

/** A product with one busy host, log errors, and a flaky website; no analytics, ads, or deployments. */
export function fixtureSources(over: Partial<ReportSources> = {}): ReportSources {
  return {
    incidents: async (w) =>
      w.localDate === '2026-10-25'
        ? { opened: 3, resolved: 2, openNow: 1, openCritical: 1 }
        : { opened: 1, resolved: 1, openNow: 0, openCritical: 0 },
    hosts: async (w) => [
      {
        hostname: 'vps-1',
        cpuAvg: w.localDate === '2026-10-25' ? 72.04 : 30.1,
        cpuMax: 97.5,
        memoryAvg: 61.234,
        diskMax: 88.06,
      },
    ],
    logErrors: async (w) =>
      w.localDate === '2026-10-25' ? { errors: 6, warnings: 40 } : { errors: 3, warnings: 41 },
    databases: async () => [{ name: 'orders-db', provider: 'postgres', status: 'healthy', ok: true }],
    websites: async () => [
      { url: 'https://shop.example.com/health?token=secret-value', uptimePercent: 98.611, tlsDays: 12 },
    ],
    deployments: async () => null,
    coverage: async () => [
      { source: 'Host metrics', status: 'ok' },
      { source: 'Website monitors', status: 'ok' },
      { source: 'Databases', status: 'ok' },
      { source: 'Log metrics', status: 'ok' },
    ],
    ...over,
  };
}
