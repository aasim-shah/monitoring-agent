export const STATUS_LABEL: Record<string, string> = {
  proposed: 'Proposed',
  rejected_policy: 'Not allowed by policy',
  pending_approval: 'Waiting for approval',
  approved: 'Approved (waiting for the target)',
  executing: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  rejected: 'Rejected',
  expired: 'Expired',
};

export const STATUS_TONE: Record<string, string | undefined> = {
  succeeded: 'border-success/40 text-success',
  failed: 'border-destructive/40 text-destructive',
  rejected_policy: 'border-destructive/40 text-destructive',
  pending_approval: 'border-warning/40 text-warning',
};

export function describeAction(
  capability: string,
  params: Record<string, unknown>,
  host: string | null,
): string {
  if (capability === 'host.restart_service') return `Restart ${String(params.unit)} on ${host ?? 'host'}`;
  if (capability === 'cloudflare.purge_cache')
    return params.everything ? 'Purge the whole Cloudflare cache' : 'Purge Cloudflare cache URLs';
  return `Run workflow ${String(params.workflow)} on ${String(params.ref)}`;
}
