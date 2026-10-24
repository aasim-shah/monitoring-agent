import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from './capabilities.js';
import { assessImpact } from './impact.js';
import { InvalidTransition, transition } from './lifecycle.js';
import { canApprove, defaultApproverRoles, evaluatePolicy, isProduction, type PolicyLike } from './policy.js';

const AGENT = '7b3c8f2a-1d4e-4c5b-9a6f-0e1d2c3b4a59';
const policy = (over: Partial<PolicyLike> = {}): PolicyLike => ({
  enabled: true,
  approverRoles: ['owner', 'admin'],
  requireApproval: true,
  settings: { units: ['firemaps-api.service'] },
  ...over,
});
const restart = (over: Record<string, unknown> = {}) => ({
  capability: 'host.restart_service' as const,
  target: { agentId: AGENT },
  params: { unit: 'firemaps-api.service' },
  proposedByAi: false,
  ...over,
});
const prod = { name: 'production' };
const staging = { name: 'staging' };

describe('capabilities (BR-16-09)', () => {
  it('accepts only plain systemd unit names', () => {
    const v = CAPABILITIES['host.restart_service'].validate;
    expect(v({ agentId: AGENT }, { unit: 'firemaps-api.service' })).toEqual([]);
    expect(v({ agentId: AGENT }, { unit: 'worker@2.service' })).toEqual([]);
    for (const unit of [
      'x.service; rm -rf /',
      '../../etc/passwd',
      'a/b.service',
      'nginx',
      '$(id).service',
      '',
    ])
      expect(v({ agentId: AGENT }, { unit }), unit).not.toEqual([]);
    expect(v({ agentId: 'not-a-uuid' }, { unit: 'a.service' })).toContain(
      'target.agentId must be an agent ID',
    );
  });

  it('limits Cloudflare purges to 30 https URLs, or everything', () => {
    const v = CAPABILITIES['cloudflare.purge_cache'].validate;
    const target = { connectionId: AGENT, zoneId: '023e105f4ecef8ad9ca31a8372d0c353' };
    expect(v(target, { urls: ['https://shop.example.com/a.css'] })).toEqual([]);
    expect(v(target, { everything: true })).toEqual([]);
    expect(v(target, { urls: Array.from({ length: 31 }, (_, i) => `https://x.example.com/${i}`) })).toContain(
      'At most 30 URLs per purge',
    );
    expect(v(target, { urls: ['ftp://x'] })).not.toEqual([]);
    expect(CAPABILITIES['cloudflare.purge_cache'].requiredApprovals({ everything: true })).toBe(2);
    expect(
      CAPABILITIES['cloudflare.purge_cache'].requiredApprovals({ urls: ['https://a.example.com/'] }),
    ).toBe(1);
  });

  it('names one target per host unit, zone, and workflow', () => {
    expect(CAPABILITIES['host.restart_service'].targetKey({ agentId: AGENT }, { unit: 'a.service' })).toBe(
      `host.restart_service:${AGENT}:a.service`,
    );
  });
});

describe('Level 1 exporters (M18.3, spec §8.9)', () => {
  const install = (exporter: unknown) => ({
    capability: 'host.install_exporter' as const,
    target: { agentId: AGENT },
    params: { exporter },
    proposedByAi: false,
  });
  it('installs and removes only the catalog exporters, one per host', () => {
    for (const cap of ['host.install_exporter', 'host.remove_exporter'] as const) {
      expect(CAPABILITIES[cap].location).toBe('agent');
      expect(CAPABILITIES[cap].validate({ agentId: AGENT }, { exporter: 'redis_exporter' })).toEqual([]);
      expect(CAPABILITIES[cap].validate({ agentId: AGENT }, { exporter: 'node_exporter' })).not.toEqual([]);
      expect(CAPABILITIES[cap].validate({ agentId: 'x' }, { exporter: 'kafka_exporter' })).not.toEqual([]);
    }
    expect(
      CAPABILITIES['host.install_exporter'].targetKey({ agentId: AGENT }, { exporter: 'redis_exporter' }),
    ).toBe(`host.exporter:${AGENT}:redis_exporter`);
  });
  it('needs the exporter in the policy allowlist', () => {
    const p = policy({ settings: { exporters: ['redis_exporter'] } });
    expect(evaluatePolicy(p, install('redis_exporter'), prod).decision).toBe('pending_approval');
    expect(evaluatePolicy(p, install('kafka_exporter'), prod)).toEqual({
      decision: 'rejected_policy',
      reason: 'kafka_exporter is not in the policy allowlist',
    });
  });
});

describe('evaluatePolicy (BR-16-01/02)', () => {
  it('TC-16-01: no policy, or a disabled one, rejects', () => {
    expect(evaluatePolicy(null, restart(), prod)).toEqual({
      decision: 'rejected_policy',
      reason: 'No enabled policy for host.restart_service in production',
    });
    expect(evaluatePolicy(policy({ enabled: false }), restart(), prod).decision).toBe('rejected_policy');
  });

  it('rejects units outside the policy allowlist and invalid targets', () => {
    expect(evaluatePolicy(policy(), restart({ params: { unit: 'sshd.service' } }), prod)).toEqual({
      decision: 'rejected_policy',
      reason: 'sshd.service is not in the policy allowlist',
    });
    expect(evaluatePolicy(policy(), restart({ params: { unit: 'x; reboot' } }), prod).decision).toBe(
      'rejected_policy',
    );
  });

  it('auto-approves only outside production, when the policy allows it, and never for the AI (TC-16-03)', () => {
    const open = policy({ requireApproval: false });
    expect(evaluatePolicy(open, restart(), staging).decision).toBe('approved');
    expect(evaluatePolicy(open, restart(), prod).decision).toBe('pending_approval');
    expect(evaluatePolicy(open, restart({ proposedByAi: true }), staging).decision).toBe('pending_approval');
    expect(evaluatePolicy(policy(), restart(), staging).decision).toBe('pending_approval');
  });

  it('TC-16-07: refuses a workflow or ref that is not allowlisted', () => {
    const p = policy({ settings: { workflows: [{ workflow: 'deploy.yml', ref: 'main' }] } });
    const dispatch = (workflow: string, ref: string) => ({
      capability: 'github.workflow_dispatch' as const,
      target: { connectionId: AGENT, repo: 'acme/shop' },
      params: { workflow, ref },
      proposedByAi: false,
    });
    expect(evaluatePolicy(p, dispatch('deploy.yml', 'main'), prod).decision).toBe('pending_approval');
    expect(evaluatePolicy(p, dispatch('deploy.yml', 'dev'), prod)).toEqual({
      decision: 'rejected_policy',
      reason: 'deploy.yml on dev is not in the policy allowlist',
    });
    expect(evaluatePolicy(p, dispatch('nuke.yml', 'main'), prod).decision).toBe('rejected_policy');
  });

  it('knows production and the default approver roles (WB-16 §13)', () => {
    expect(isProduction('Production')).toBe(true);
    expect(isProduction('prod')).toBe(true);
    expect(isProduction('staging')).toBe(false);
    expect(defaultApproverRoles(true)).toEqual(['owner', 'admin']);
    expect(defaultApproverRoles(false)).toEqual(['owner', 'admin', 'operator']);
  });
});

describe('canApprove (BR-16-03)', () => {
  const req = {
    requestedByUserId: 'u-req',
    capability: 'host.restart_service' as const,
    params: { unit: 'a.service' },
  };
  it('TC-16-02: refuses self-approval in production, allows it elsewhere', () => {
    expect(
      canApprove({
        request: req,
        approver: { userId: 'u-req', roles: ['owner'] },
        approvals: [],
        policy: policy(),
        production: true,
      }),
    ).toEqual({
      ok: false,
      code: 'self_approval',
      reason: 'In production the approver must be someone other than the requester',
    });
    expect(
      canApprove({
        request: req,
        approver: { userId: 'u-req', roles: ['owner'] },
        approvals: [],
        policy: policy(),
        production: false,
      }),
    ).toEqual({ ok: true, complete: true });
  });

  it('refuses members without an approver role, and repeated decisions', () => {
    expect(
      canApprove({
        request: req,
        approver: { userId: 'u2', roles: ['operator'] },
        approvals: [],
        policy: policy(),
        production: true,
      }),
    ).toMatchObject({ ok: false, code: 'not_an_approver' });
    expect(
      canApprove({
        request: req,
        approver: { userId: 'u2', roles: ['admin'] },
        approvals: [{ userId: 'u2', decision: 'approve' }],
        policy: policy(),
        production: true,
      }),
    ).toMatchObject({ ok: false, code: 'already_decided' });
  });

  it('TC-16-08: purge-everything completes only with a second, different approver', () => {
    const purge = {
      requestedByUserId: 'u-req',
      capability: 'cloudflare.purge_cache' as const,
      params: { everything: true },
    };
    const first = canApprove({
      request: purge,
      approver: { userId: 'a1', roles: ['admin'] },
      approvals: [],
      policy: policy(),
      production: true,
    });
    expect(first).toEqual({ ok: true, complete: false });
    expect(
      canApprove({
        request: purge,
        approver: { userId: 'a2', roles: ['owner'] },
        approvals: [{ userId: 'a1', decision: 'approve' }],
        policy: policy(),
        production: true,
      }),
    ).toEqual({ ok: true, complete: true });
  });
});

describe('lifecycle (WB-16 §4)', () => {
  it('follows the request state machine and refuses anything else', () => {
    expect(transition('proposed', 'needs_approval')).toBe('pending_approval');
    expect(transition('pending_approval', 'approve')).toBe('approved');
    expect(transition('pending_approval', 'expire')).toBe('expired');
    expect(transition('approved', 'execute')).toBe('executing');
    expect(transition('executing', 'succeed')).toBe('succeeded');
    expect(transition('executing', 'fail')).toBe('failed');
    expect(() => transition('succeeded', 'execute')).toThrow(InvalidTransition);
    expect(() => transition('rejected', 'approve')).toThrow(InvalidTransition);
  });
});

describe('assessImpact (UC-16-04)', () => {
  it('names the dependents a restart may interrupt', () => {
    expect(
      assessImpact({
        action: 'Restarting firemaps-api.service on vps-1',
        dependents: [
          { name: 'Orders API', type: 'service' },
          { name: 'firemaps.example', type: 'website' },
        ],
      }),
    ).toEqual({
      summary:
        'Restarting firemaps-api.service on vps-1 may interrupt 2 dependents: Orders API, firemaps.example.',
      dependents: [
        { name: 'Orders API', type: 'service' },
        { name: 'firemaps.example', type: 'website' },
      ],
    });
    expect(assessImpact({ action: 'Restarting a.service on h', dependents: [] }).summary).toBe(
      'Restarting a.service on h has no known dependents in the asset graph.',
    );
  });
});
