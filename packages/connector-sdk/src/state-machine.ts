import type { ConnectionStatus } from '@pcp/shared-contracts';

export type StatusEvent =
  | 'auth_started'
  | 'auth_completed'
  | 'validated'
  | 'validation_failed'
  | 'degraded'
  | 'recovered'
  | 'revoked'
  | 'disconnected';

const LIVE_EXITS: Partial<Record<StatusEvent, ConnectionStatus>> = {
  disconnected: 'disconnected',
  revoked: 'revoked',
};

/** Connection lifecycle (spec §9.1, WB-02). `disconnected` and `revoked` are terminal. */
const TRANSITIONS: Record<ConnectionStatus, Partial<Record<StatusEvent, ConnectionStatus>>> = {
  draft: { auth_started: 'pending_auth', auth_completed: 'pending_validation', ...LIVE_EXITS },
  pending_auth: { auth_completed: 'pending_validation', ...LIVE_EXITS },
  pending_validation: {
    validated: 'connected',
    validation_failed: 'degraded',
    // Credentials resubmitted before the worker validated the first set.
    auth_completed: 'pending_validation',
    ...LIVE_EXITS,
  },
  connected: {
    validated: 'connected',
    validation_failed: 'degraded',
    degraded: 'degraded',
    auth_completed: 'pending_validation',
    ...LIVE_EXITS,
  },
  degraded: {
    recovered: 'connected',
    validated: 'connected',
    validation_failed: 'degraded',
    degraded: 'degraded',
    auth_completed: 'pending_validation',
    ...LIVE_EXITS,
  },
  disconnected: {},
  revoked: {},
};

export function transition(from: ConnectionStatus, event: StatusEvent): ConnectionStatus {
  const to = TRANSITIONS[from][event];
  if (!to) throw new Error(`illegal connection transition ${from} → ${event}`);
  return to;
}
