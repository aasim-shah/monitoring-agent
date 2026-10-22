import { describe, expect, it } from 'vitest';
import { transition } from './index.js';

describe('connection state machine (spec §9.1)', () => {
  it('follows the token flow to connected', () => {
    expect(transition('draft', 'auth_completed')).toBe('pending_validation');
    expect(transition('pending_validation', 'validated')).toBe('connected');
  });

  it('follows the OAuth flow', () => {
    expect(transition('draft', 'auth_started')).toBe('pending_auth');
    expect(transition('pending_auth', 'auth_completed')).toBe('pending_validation');
  });

  it('degrades and recovers', () => {
    expect(transition('pending_validation', 'validation_failed')).toBe('degraded');
    expect(transition('connected', 'degraded')).toBe('degraded');
    expect(transition('degraded', 'recovered')).toBe('connected');
    expect(transition('degraded', 'auth_completed')).toBe('pending_validation');
  });

  it('rejects illegal transitions', () => {
    expect(() => transition('draft', 'validated')).toThrow(/draft → validated/);
    expect(() => transition('disconnected', 'auth_completed')).toThrow();
    expect(() => transition('revoked', 'recovered')).toThrow();
  });

  it('can disconnect or revoke from any live state', () => {
    for (const s of ['draft', 'pending_auth', 'pending_validation', 'connected', 'degraded'] as const) {
      expect(transition(s, 'disconnected')).toBe('disconnected');
    }
    expect(transition('connected', 'revoked')).toBe('revoked');
  });
});
