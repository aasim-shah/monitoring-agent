import { describe, expect, it } from 'vitest';
import { validateMessage } from './index.js';

const enroll = {
  protocolVersion: '1.0',
  enrollmentToken: 'tok_0123456789abcdef',
  agentVersion: '1.0.0',
  agentType: 'host',
  csrPem: '-----BEGIN CERTIFICATE REQUEST-----\nMIIB\n-----END CERTIFICATE REQUEST-----',
  x25519PublicKey: 'pk',
  host: { hostname: 'api-vps-01', machineId: 'abc', os: 'ubuntu-24.04', arch: 'amd64' },
};

const heartbeat = {
  protocolVersion: '1.0',
  sequence: 1,
  agentVersion: '1.0.0',
  policyVersion: 3,
  capabilities: ['host.health'],
  health: 'ok',
  queueDepth: 0,
  sentAt: '2026-10-22T12:00:00Z',
};

const task = {
  id: '6f1c2f0e-6b9a-4c1e-9d2a-1f3e5b7c9d01',
  type: 'live_boost',
  expiresAt: '2026-10-22T12:10:00Z',
  resourceScope: { packId: 'redis' },
  maxRuntimeSeconds: 600,
  maxResponseBytes: 65536,
  payload: { intervalSeconds: 5 },
  signature: 'sig',
};

describe('validateMessage', () => {
  it('accepts a valid enroll request', () => {
    expect(validateMessage('enroll-request', enroll)).toEqual({ ok: true });
  });
  it('rejects an enroll request carrying organizationId', () => {
    expect(validateMessage('enroll-request', { ...enroll, organizationId: 'org-1' }).ok).toBe(false);
  });
  it('rejects a heartbeat without sequence', () => {
    const { sequence: _omit, ...rest } = heartbeat;
    expect(validateMessage('heartbeat', rest).ok).toBe(false);
  });
  it('accepts a valid agent task and rejects an unknown task type', () => {
    expect(validateMessage('agent-task', task)).toEqual({ ok: true });
    expect(validateMessage('agent-task', { ...task, type: 'shell' }).ok).toBe(false);
  });
});
