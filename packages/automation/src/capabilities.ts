export type Capability = 'host.restart_service' | 'cloudflare.purge_cache' | 'github.workflow_dispatch';

type Bag = Record<string, unknown>;

export interface CapabilityDef {
  label: string;
  /** agent: a signed task through pcp-helper; platform: a provider API call. */
  location: 'agent' | 'platform';
  /** Problems with the target or parameters; empty when valid (BR-16-09: nothing free-form runs). */
  validate(target: Bag, params: Bag): string[];
  /** One action per target at a time (BR-16-06). */
  targetKey(target: Bag, params: Bag): string;
  /** Distinct approvers needed (purge-everything needs two, UC-16-06). */
  requiredApprovals(params: Bag): number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A systemd service unit: no paths, spaces, or shell characters. */
export const UNIT = /^[A-Za-z0-9@._-]+\.service$/;
const WORKFLOW = /^[A-Za-z0-9._-]+\.ya?ml$/;
const REF = /^[A-Za-z0-9._/-]{1,100}$/;
const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
export const MAX_PURGE_URLS = 30;

const str = (v: unknown) => (typeof v === 'string' ? v : '');

function httpsUrl(v: unknown): boolean {
  try {
    return new URL(str(v)).protocol === 'https:';
  } catch {
    return false;
  }
}

export const CAPABILITIES: Record<Capability, CapabilityDef> = {
  'host.restart_service': {
    label: 'Restart service',
    location: 'agent',
    validate(target, params) {
      const issues: string[] = [];
      if (!UUID.test(str(target.agentId))) issues.push('target.agentId must be an agent ID');
      const unit = str(params.unit);
      if (!UNIT.test(unit) || unit.includes('..'))
        issues.push('params.unit must be a systemd unit such as api.service');
      return issues;
    },
    targetKey: (target, params) => `host.restart_service:${str(target.agentId)}:${str(params.unit)}`,
    requiredApprovals: () => 1,
  },
  'cloudflare.purge_cache': {
    label: 'Purge Cloudflare cache',
    location: 'platform',
    validate(target, params) {
      const issues: string[] = [];
      if (!UUID.test(str(target.connectionId))) issues.push('target.connectionId must be a connection ID');
      if (!/^[A-Za-z0-9]{1,64}$/.test(str(target.zoneId)))
        issues.push('target.zoneId must be a Cloudflare zone ID');
      const urls = params.urls;
      if (params.everything === true) {
        if (urls !== undefined) issues.push('Purge either URLs or everything, not both');
      } else if (!Array.isArray(urls) || urls.length === 0)
        issues.push('params.urls must list the URLs to purge');
      else {
        if (urls.length > MAX_PURGE_URLS) issues.push(`At most ${MAX_PURGE_URLS} URLs per purge`);
        if (!urls.every(httpsUrl)) issues.push('Every URL must be an https:// URL');
      }
      return issues;
    },
    targetKey: (target) => `cloudflare.purge_cache:${str(target.zoneId)}`,
    requiredApprovals: (params) => (params.everything === true ? 2 : 1),
  },
  'github.workflow_dispatch': {
    label: 'Run GitHub workflow',
    location: 'platform',
    validate(target, params) {
      const issues: string[] = [];
      if (!UUID.test(str(target.connectionId))) issues.push('target.connectionId must be a connection ID');
      if (!REPO.test(str(target.repo))) issues.push('target.repo must be owner/name');
      if (!WORKFLOW.test(str(params.workflow)))
        issues.push('params.workflow must be a workflow file such as deploy.yml');
      const ref = str(params.ref);
      if (!REF.test(ref) || ref.includes('..')) issues.push('params.ref must be a branch or tag');
      return issues;
    },
    targetKey: (target, params) => `github.workflow_dispatch:${str(target.repo)}:${str(params.workflow)}`,
    requiredApprovals: () => 1,
  },
};

export const isCapability = (c: string): c is Capability => c in CAPABILITIES;
