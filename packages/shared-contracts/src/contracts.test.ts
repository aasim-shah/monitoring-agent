import { describe, expect, it } from 'vitest';
import {
  CONNECTOR_CAPABILITIES,
  PERMISSIONS,
  RELATION_TYPES,
  ROLES,
  TOOL_NAMES,
  connectorCapabilitySchema,
  observationSchema,
  packManifestSchema,
  relationTypeSchema,
  ROLE_PERMISSIONS,
  can,
} from './index.js';

const observation = {
  source: 'provider_api',
  provider: 'cloudflare',
  resourceType: 'dns_record',
  externalId: 'rec-1',
  attributes: { hostname: 'api.example.com' },
  observedAt: '2026-10-22T12:00:00Z',
  method: 'provider_api',
  confidence: 0.95,
  evidence: {},
};

const redisPack = {
  id: 'redis',
  version: '1.0.0',
  detect: [{ process: 'redis-server' }, { port: 6379 }],
  changeLevel: 0,
  credentials: [{ name: 'redis_monitor', hint: 'Read-only ACL user' }],
  collector: { receivers: { redis: { endpoint: '127.0.0.1:6379' } } },
  metricAllowlist: ['redis.*'],
  alerts: [
    { id: 'redis-evictions', description: 'Keys evicted', expr: 'x > 0', for: '10m', severity: 'warning' },
  ],
  panels: 'panels.yaml',
  graph: { assetType: 'redis_instance', edges: [{ type: 'HOSTS', from: 'host' }] },
};

describe('roles and permissions', () => {
  it('defines the five roles and the master-plan permission list', () => {
    expect(ROLES).toEqual(['owner', 'admin', 'operator', 'analyst', 'viewer']);
    expect(PERMISSIONS).toHaveLength(25);
    expect(PERMISSIONS).toContain('action.approve');
  });
});

describe('connector capabilities', () => {
  it('has exactly the 11 spec §9 capabilities', () => {
    expect(CONNECTOR_CAPABILITIES).toHaveLength(11);
    expect(CONNECTOR_CAPABILITIES).toContain('webhook_registration');
  });
  it('rejects an unknown capability', () => {
    expect(connectorCapabilitySchema.safeParse('teleport').success).toBe(false);
  });
});

describe('observation', () => {
  it('accepts confidence within 0..1', () => {
    expect(observationSchema.safeParse(observation).success).toBe(true);
  });
  it.each([1.5, -0.1])('rejects confidence %s', (confidence) => {
    expect(observationSchema.safeParse({ ...observation, confidence }).success).toBe(false);
  });
  it('rejects organizationId set by a connector', () => {
    expect(observationSchema.safeParse({ ...observation, organizationId: 'org' }).success).toBe(false);
  });
});

describe('graph vocabulary', () => {
  it('has 14 relation types including DEPLOYS', () => {
    expect(RELATION_TYPES).toHaveLength(14);
    expect(relationTypeSchema.safeParse('DEPLOYS').success).toBe(true);
    expect(relationTypeSchema.safeParse('FOO').success).toBe(false);
  });
});

describe('AI tools', () => {
  it('has the 18 canonical tool names', () => {
    expect(TOOL_NAMES).toHaveLength(18);
    expect(TOOL_NAMES).toContain('getApplicationMetrics');
  });
});

describe('pack manifest', () => {
  it('parses a valid redis pack', () => {
    expect(packManifestSchema.safeParse(redisPack).success).toBe(true);
  });
  it('rejects change level 3', () => {
    expect(packManifestSchema.safeParse({ ...redisPack, changeLevel: 3 }).success).toBe(false);
  });
});

describe('role matrix in shared contracts', () => {
  const ctx = (role: (typeof ROLES)[number]) => ({
    organizationId: 'o',
    actor: { kind: 'user' as const, userId: 'u' },
    roles: [role],
    productIds: 'all' as const,
    environmentIds: 'all' as const,
    requestId: 'r',
  });
  it('is importable in the browser and matches tenant-security', () => {
    expect(can(ctx('owner'), 'org.members.manage')).toBe(true);
    expect(can(ctx('viewer'), 'org.members.manage')).toBe(false);
    expect(ROLE_PERMISSIONS.viewer).toContain('org.view');
  });
});
