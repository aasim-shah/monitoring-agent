import { describe, expect, it } from 'vitest';
import { agentStatus } from './status.js';

const created = new Date('2026-10-22T12:00:00Z');
const at = (seconds: number) => new Date(created.getTime() + seconds * 1000);

describe('agentStatus (spec §8.2, §3)', () => {
  it('is active within 90 s of the last heartbeat and degraded after (TC-03-07)', () => {
    const a = { status: 'active' as const, lastHeartbeatAt: created, createdAt: created };
    expect(agentStatus(a, at(89))).toEqual({ status: 'active', stale: false });
    expect(agentStatus(a, at(91))).toEqual({ status: 'degraded', stale: false });
  });

  it('recovers to active on a new heartbeat', () => {
    expect(
      agentStatus({ status: 'active', lastHeartbeatAt: at(200), createdAt: created }, at(210)).status,
    ).toBe('active');
  });

  it('counts from enrollment when no heartbeat arrived yet', () => {
    const a = { status: 'active' as const, lastHeartbeatAt: null, createdAt: created };
    expect(agentStatus(a, at(30)).status).toBe('active');
    expect(agentStatus(a, at(120)).status).toBe('degraded');
  });

  it('is stale after 5 minutes', () => {
    const a = { status: 'active' as const, lastHeartbeatAt: created, createdAt: created };
    expect(agentStatus(a, at(299)).stale).toBe(false);
    expect(agentStatus(a, at(301))).toEqual({ status: 'degraded', stale: true });
  });

  it('revoked wins', () => {
    expect(agentStatus({ status: 'revoked', lastHeartbeatAt: at(0), createdAt: created }, at(1))).toEqual({
      status: 'revoked',
      stale: false,
    });
  });
});
