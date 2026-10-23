import { describe, expect, it } from 'vitest';
import { fixtureSources } from './fixtures.js';
import { renderReport } from './render.js';
import { buildSnapshot } from './snapshot.js';
import { reportWindow } from './window.js';

const w = reportWindow('Europe/Berlin', new Date('2026-10-26T07:00:00Z'));
const link = 'https://monitor.example.com/orgs/o/products/p/reports/r';

describe('renderReport (UC-15-03)', () => {
  it('renders every section for email, Slack, and webhook', async () => {
    const snapshot = await buildSnapshot(fixtureSources({ hosts: async () => null }), w);
    const m = renderReport(
      {
        snapshot,
        narrative: 'Quiet day [S2].',
        narrativeStatus: 'verified',
        productName: 'Shop',
        late: false,
      },
      link,
    );
    expect(m.subject).toBe('Daily report — Shop — 2026-10-25');
    expect(m.text).toContain('Data coverage and missing sources');
    expect(m.text).toContain('Infrastructure performance\nNo data: No host metrics in this window');
    expect(m.text).toContain('User analytics\nNo data: Google Analytics not connected (M13b)');
    expect(m.text).toContain('Quiet day [S2].');
    expect(m.text).toContain(link);
    expect(m.text).not.toMatch(/Infrastructure performance\n.*0 %/);
    expect(m.html).toContain('<h2>Significant anomalies</h2>');
    expect(m.slack.text).toContain(`<${link}|Open the report>`);
    expect(m.json).toMatchObject({
      type: 'report',
      localDate: '2026-10-25',
      link,
      narrativeStatus: 'verified',
    });
  });

  it('says when the narrative is deferred or the run was late, and escapes HTML', async () => {
    const snapshot = await buildSnapshot(
      fixtureSources({
        hosts: async () => [{ hostname: '<b>x</b>', cpuAvg: 1, cpuMax: 1, memoryAvg: 1, diskMax: 1 }],
      }),
      w,
    );
    const m = renderReport(
      { snapshot, narrative: null, narrativeStatus: 'deferred', productName: 'Shop', late: true },
      link,
    );
    expect(m.text).toContain('Narrative deferred: the AI summary could not be verified against the data.');
    expect(m.text).toContain('Generated late');
    expect(m.html).not.toContain('<b>x</b>');
    expect(m.html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
});
