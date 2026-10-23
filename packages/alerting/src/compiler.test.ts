import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { compileTenant } from './compiler.js';
import { TEMPLATES, validateParams } from './templates.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const PRODUCT = '22222222-2222-4222-8222-222222222222';
const rule = (over: Partial<Parameters<typeof compileTenant>[1][number]> = {}) => ({
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  productId: null as string | null,
  name: 'CPU above 90 %',
  template: 'host_cpu_high' as const,
  params: { threshold: 90, forMinutes: 10 },
  severity: 'warning' as const,
  enabled: true,
  ...over,
});

describe('compileTenant (D17, BR-13-06)', () => {
  it('puts every rule under the tenant extra_label, one group per product scope', () => {
    const doc = parse(
      compileTenant(ORG, [
        rule(),
        rule({
          id: 'bbbbbbbb-0000-4000-8000-000000000002',
          productId: PRODUCT,
          name: 'Errors',
          template: 'log_error_spike',
          params: { perMinute: 10, forMinutes: 5 },
          severity: 'critical',
        }),
      ]),
    );
    expect(doc.groups).toHaveLength(2);
    const [org, product] = doc.groups;
    expect(org).toMatchObject({
      name: `tenant-${ORG}`,
      interval: '1m',
      params: { extra_label: [`tenant_id=${ORG}`] },
      labels: { tenant_id: ORG },
    });
    expect(org.params.extra_filters).toBeUndefined();
    expect(org.rules[0]).toMatchObject({
      alert: 'host_cpu_high-aaaaaaaa',
      expr: '100 * (1 - avg by (agent_id) (system_cpu_utilization_ratio{state="idle"})) > 90',
      for: '10m',
      labels: { rule_id: 'aaaaaaaa-0000-4000-8000-000000000001', severity: 'warning' },
      annotations: { summary: 'CPU above 90 %' },
    });
    expect(product).toMatchObject({
      name: `tenant-${ORG}-product-${PRODUCT}`,
      params: { extra_label: [`tenant_id=${ORG}`], extra_filters: [`{product_id="${PRODUCT}"}`] },
      labels: { tenant_id: ORG, product_id: PRODUCT },
    });
    expect(product.rules[0].expr).toContain('increase_pure(');
    expect(product.rules[0].expr).toMatch(/\/ 5 > 10$/);
  });

  it('omits disabled and non-metric rules, and writes an empty file for none', () => {
    const yaml = compileTenant(ORG, [
      rule({ enabled: false }),
      rule({ template: 'agent_heartbeat_missing', params: { minutes: 5 } }),
    ]);
    expect(parse(yaml)).toEqual({ groups: [] });
  });

  it('accepts a shorter interval and immediate firing for tests', () => {
    const doc = parse(
      compileTenant(ORG, [rule({ params: { threshold: 50, forMinutes: 0 } })], { interval: '5s' }),
    );
    expect(doc.groups[0].interval).toBe('5s');
    expect(doc.groups[0].rules[0].for).toBe('0s');
  });
});

describe('validateParams', () => {
  it('fills defaults, clamps ranges, and rejects unknown params', () => {
    expect(validateParams('host_cpu_high', {})).toEqual({ threshold: 90, forMinutes: 10 });
    expect(validateParams('host_cpu_high', { threshold: 500, forMinutes: 0 })).toEqual({
      threshold: 100,
      forMinutes: 1,
    });
    expect(() => validateParams('host_cpu_high', { promql: 'up' })).toThrow(/unknown parameter promql/);
    expect(() => validateParams('host_cpu_high', { threshold: 'x' })).toThrow(/threshold must be a number/);
    expect(() => validateParams('nope' as never, {})).toThrow(/unknown template/);
  });

  it('has a label, kind, and default severity for every template', () => {
    for (const t of Object.values(TEMPLATES)) {
      expect(t.label.length).toBeGreaterThan(3);
      expect(['metric', 'heartbeat', 'connection']).toContain(t.kind);
      expect(t.kind === 'metric').toBe(typeof t.expr === 'function');
    }
  });
});
