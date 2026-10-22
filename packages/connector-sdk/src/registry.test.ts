import { describe, expect, it } from 'vitest';
import { ConnectorRegistry, type Connector } from './index.js';

const base = (overrides: Partial<Connector> = {}): Connector => ({
  type: 'demo',
  version: '1.0.0',
  displayName: 'Demo',
  executionLocations: ['cloud'],
  credentialFields: [{ name: 'token', label: 'API token', secret: true }],
  configSchema: () => ({ type: 'object', properties: {}, additionalProperties: false }),
  capabilities: () => ['validate'],
  validate: async () => ({ ok: true }),
  ...overrides,
});

describe('ConnectorRegistry', () => {
  it('registers a connector and lists catalog entries', () => {
    const r = new ConnectorRegistry();
    r.register(base());
    expect(r.list()).toEqual([
      {
        type: 'demo',
        version: '1.0.0',
        displayName: 'Demo',
        capabilities: ['validate'],
        executionLocations: ['cloud'],
        credentialFields: [{ name: 'token', label: 'API token', secret: true }],
        configSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
    ]);
    expect(r.get('demo').type).toBe('demo');
  });

  it('rejects a declared capability without its method', () => {
    expect(() =>
      new ConnectorRegistry().register(base({ capabilities: () => ['validate', 'sync'] })),
    ).toThrow(/sync/);
  });

  it('rejects an implemented method without its declared capability', () => {
    expect(() =>
      new ConnectorRegistry().register(base({ discover: async () => ({ observations: [] }) })),
    ).toThrow(/discover/);
  });

  it('rejects duplicates and unknown lookups', () => {
    const r = new ConnectorRegistry();
    r.register(base());
    expect(() => r.register(base())).toThrow(/already registered/);
    expect(() => r.get('nope')).toThrow(/unknown connector/);
  });
});
