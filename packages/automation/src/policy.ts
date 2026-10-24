import { CAPABILITIES, type Capability } from './capabilities.js';

export interface PolicyLike {
  enabled: boolean;
  approverRoles: string[];
  requireApproval: boolean;
  /** Allowlists: units (host), exporters (Level 1), zones (Cloudflare), workflows with refs (GitHub). */
  settings: {
    units?: string[];
    exporters?: string[];
    zones?: string[];
    workflows?: Array<{ workflow: string; ref: string }>;
  };
}

export interface ProposalLike {
  capability: Capability;
  target: Record<string, unknown>;
  params: Record<string, unknown>;
  proposedByAi: boolean;
}

export type PolicyDecision = 'rejected_policy' | 'pending_approval' | 'approved';

export const isProduction = (environmentName: string) => /^(production|prod)$/i.test(environmentName.trim());

/** Spec open decision #7, WB-16 §13: Owner/Admin approve production, Operator and up elsewhere. */
export const defaultApproverRoles = (production: boolean) =>
  production ? ['owner', 'admin'] : ['owner', 'admin', 'operator'];

function allowlisted(policy: PolicyLike, p: ProposalLike): string | null {
  const s = policy.settings ?? {};
  if (p.capability === 'host.restart_service') {
    const unit = String(p.params.unit);
    return (s.units ?? []).includes(unit) ? null : `${unit} is not in the policy allowlist`;
  }
  if (p.capability === 'host.install_exporter' || p.capability === 'host.remove_exporter') {
    const exporter = String(p.params.exporter);
    return (s.exporters ?? []).includes(exporter) ? null : `${exporter} is not in the policy allowlist`;
  }
  if (p.capability === 'cloudflare.purge_cache') {
    const zone = String(p.target.zoneId);
    return (s.zones ?? []).includes(zone) ? null : `Zone ${zone} is not in the policy allowlist`;
  }
  const { workflow, ref } = p.params as { workflow: string; ref: string };
  return (s.workflows ?? []).some((w) => w.workflow === workflow && w.ref === ref)
    ? null
    : `${workflow} on ${ref} is not in the policy allowlist`;
}

/**
 * Policy check for a proposal (spec §13.5 B–E). Without an enabled policy nothing runs
 * (BR-16-01). Only an explicit no-approval policy outside production skips approval, and never
 * for the AI (BR-16-02).
 */
export function evaluatePolicy(
  policy: PolicyLike | null,
  proposal: ProposalLike,
  environment: { name: string },
): { decision: PolicyDecision; reason: string } {
  if (!policy?.enabled)
    return {
      decision: 'rejected_policy',
      reason: `No enabled policy for ${proposal.capability} in ${environment.name}`,
    };
  const issues = CAPABILITIES[proposal.capability].validate(proposal.target, proposal.params);
  if (issues.length) return { decision: 'rejected_policy', reason: issues.join('; ') };
  const denied = allowlisted(policy, proposal);
  if (denied) return { decision: 'rejected_policy', reason: denied };
  if (!policy.requireApproval && !isProduction(environment.name) && !proposal.proposedByAi)
    return { decision: 'approved', reason: 'Policy allows this action without approval' };
  return {
    decision: 'pending_approval',
    reason: proposal.proposedByAi ? 'Proposed by the AI: approval required' : 'Approval required by policy',
  };
}

export type ApprovalCheck =
  | { ok: true; complete: boolean }
  | { ok: false; code: 'self_approval' | 'not_an_approver' | 'already_decided'; reason: string };

/**
 * May this member approve (BR-16-03)? `complete` is true when this approval reaches the number
 * the capability needs (two distinct approvers for purge-everything).
 */
export function canApprove(input: {
  request: { requestedByUserId: string | null; capability: Capability; params: Record<string, unknown> };
  approver: { userId: string; roles: string[] };
  approvals: Array<{ userId: string; decision: string }>;
  policy: PolicyLike;
  production: boolean;
}): ApprovalCheck {
  const { request, approver, approvals, policy, production } = input;
  const roles = policy.approverRoles.length ? policy.approverRoles : defaultApproverRoles(production);
  if (!approver.roles.some((r) => roles.includes(r)))
    return { ok: false, code: 'not_an_approver', reason: `Approvers for this policy: ${roles.join(', ')}` };
  if (production && request.requestedByUserId === approver.userId)
    return {
      ok: false,
      code: 'self_approval',
      reason: 'In production the approver must be someone other than the requester',
    };
  if (approvals.some((a) => a.userId === approver.userId))
    return { ok: false, code: 'already_decided', reason: 'You already decided on this request' };
  const approved = approvals.filter((a) => a.decision === 'approve').length + 1;
  return {
    ok: true,
    complete: approved >= CAPABILITIES[request.capability].requiredApprovals(request.params),
  };
}
