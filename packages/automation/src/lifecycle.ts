export type RequestStatus =
  | 'proposed'
  | 'rejected_policy'
  | 'pending_approval'
  | 'approved'
  | 'executing'
  | 'succeeded'
  | 'failed'
  | 'rejected'
  | 'expired';

export type RequestEvent =
  | 'policy_rejected'
  | 'needs_approval'
  | 'auto_approved'
  | 'approve'
  | 'reject'
  | 'expire'
  | 'execute'
  | 'succeed'
  | 'fail';

export class InvalidTransition extends Error {
  constructor(from: RequestStatus, event: RequestEvent) {
    super(`cannot ${event} a request that is ${from}`);
  }
}

/** The request state machine (WB-16 §4); anything not listed is refused. */
const NEXT: Partial<Record<RequestStatus, Partial<Record<RequestEvent, RequestStatus>>>> = {
  proposed: {
    policy_rejected: 'rejected_policy',
    needs_approval: 'pending_approval',
    auto_approved: 'approved',
  },
  pending_approval: { approve: 'approved', reject: 'rejected', expire: 'expired' },
  approved: { execute: 'executing', expire: 'expired' },
  executing: { succeed: 'succeeded', fail: 'failed', expire: 'expired' },
};

export function transition(from: RequestStatus, event: RequestEvent): RequestStatus {
  const to = NEXT[from]?.[event];
  if (!to) throw new InvalidTransition(from, event);
  return to;
}
