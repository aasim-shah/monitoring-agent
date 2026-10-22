import { GenericContainer, Wait } from 'testcontainers';

export interface TestVictoria {
  url: string;
  /** Imports Prometheus text lines (`name{labels} value timestamp_ms`) and flushes them. */
  importLines(lines: string[]): Promise<void>;
  stop(): Promise<void>;
}

/** VictoriaMetrics with the production flags that matter to queries (retention, dedup). */
export async function startVictoria(): Promise<TestVictoria> {
  const container = await new GenericContainer('victoriametrics/victoria-metrics:v1.126.0')
    .withCommand(['-retentionPeriod=15d', '-dedup.minScrapeInterval=1s', '-search.latencyOffset=0s'])
    .withExposedPorts(8428)
    .withWaitStrategy(Wait.forHttp('/health', 8428))
    .start();
  const url = `http://${container.getHost()}:${container.getMappedPort(8428)}`;
  return {
    url,
    async importLines(lines) {
      const res = await fetch(`${url}/api/v1/import/prometheus`, { method: 'POST', body: lines.join('\n') + '\n' });
      if (!res.ok) throw new Error(`import failed: ${res.status} ${await res.text()}`);
      await fetch(`${url}/internal/force_flush`);
    },
    async stop() {
      await container.stop();
    },
  };
}
