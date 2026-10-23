import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GenericContainer,
  Network,
  Wait,
  type StartedNetwork,
  type StartedTestContainer,
} from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileTenant } from './compiler.js';

// TC-13-01: a tenant's rule never fires on another tenant's series (BR-13-06).
const A = 'aaaaaaaa-1111-4111-8111-111111111111';
const B = 'bbbbbbbb-2222-4222-8222-222222222222';

let network: StartedNetwork;
let vm: StartedTestContainer;
let vmalert: StartedTestContainer;
let vmUrl: string;
let vmalertUrl: string;

beforeAll(async () => {
  network = await new Network().start();
  vm = await new GenericContainer('victoriametrics/victoria-metrics:v1.126.0')
    .withNetwork(network)
    .withNetworkAliases('victoriametrics')
    .withCommand(['-search.latencyOffset=0s'])
    .withExposedPorts(8428)
    .withWaitStrategy(Wait.forHttp('/health', 8428))
    .start();
  vmUrl = `http://${vm.getHost()}:${vm.getMappedPort(8428)}`;
  const now = Date.now();
  // Both tenants run hot; the agent IDs even look alike.
  const lines = [A, B].flatMap((tenant) =>
    [0, 15, 30, 45].map(
      (s) =>
        `system_cpu_utilization_ratio{tenant_id="${tenant}",agent_id="agent-1",state="idle",cpu="cpu0"} 0.02 ${now - s * 1000}`,
    ),
  );
  await fetch(`${vmUrl}/api/v1/import/prometheus`, { method: 'POST', body: lines.join('\n') + '\n' });
  await fetch(`${vmUrl}/internal/force_flush`);

  const dir = mkdtempSync(join(tmpdir(), 'pcp-rules-'));
  chmodSync(dir, 0o755);
  writeFileSync(
    join(dir, `tenant-${A}.yaml`),
    compileTenant(
      A,
      [
        {
          id: 'cccccccc-0000-4000-8000-000000000001',
          productId: null,
          name: 'CPU high',
          template: 'host_cpu_high',
          params: { threshold: 50, forMinutes: 0 },
          severity: 'critical',
          enabled: true,
        },
      ],
      { interval: '5s' },
    ),
  );
  vmalert = await new GenericContainer('victoriametrics/vmalert:v1.126.0')
    .withNetwork(network)
    .withBindMounts([{ source: dir, target: '/rules', mode: 'ro' }])
    .withCommand([
      '-datasource.url=http://victoriametrics:8428',
      '-rule=/rules/*.yaml',
      '-notifier.blackhole',
      '-evaluationInterval=5s',
      '-httpListenAddr=:8880',
    ])
    .withExposedPorts(8880)
    .withWaitStrategy(Wait.forHttp('/health', 8880))
    .start();
  vmalertUrl = `http://${vmalert.getHost()}:${vmalert.getMappedPort(8880)}`;
}, 300_000);

afterAll(async () => {
  await vmalert?.stop();
  await vm?.stop();
  await network?.stop();
});

describe('vmalert with a compiled tenant group (TC-13-01)', () => {
  it("fires for tenant A's series only, labelled with A", async () => {
    let alerts: Array<{ labels: Record<string, string>; state: string }> = [];
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const body = (await (await fetch(`${vmalertUrl}/api/v1/alerts`)).json()) as {
        data: { alerts: typeof alerts };
      };
      alerts = body.data.alerts;
      if (alerts.some((a) => a.state === 'firing')) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      state: 'firing',
      labels: { tenant_id: A, agent_id: 'agent-1', rule_id: 'cccccccc-0000-4000-8000-000000000001' },
    });
    expect(JSON.stringify(alerts)).not.toContain(B);
  });
});
