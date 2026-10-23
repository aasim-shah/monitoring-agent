// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionDetail, type ActionDetailData } from './action-detail';
import { ActionList, type ActionRow } from './action-list';
import { PolicyList, type PolicyRow } from './policy-list';

afterEach(cleanup);

const policy = (over: Partial<PolicyRow> = {}): PolicyRow => ({
  environmentId: 'e-prod',
  environmentName: 'production',
  production: true,
  capability: 'host.restart_service',
  label: 'Restart service',
  enabled: false,
  approverRoles: ['owner', 'admin'],
  requireApproval: true,
  settings: {},
  available: true,
  ...over,
});

describe('PolicyList (WB-16 UC-16-01)', () => {
  it('starts disabled, and saves an enabled policy with its unit allowlist', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<PolicyList policies={[policy()]} canManage onSave={onSave} />);
    const row = screen.getByRole('row', { name: /Restart service · production/ });
    expect(within(row).getByText('Disabled')).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Edit' }));
    await user.click(screen.getByLabelText('Enabled'));
    await user.type(
      screen.getByLabelText('Units that may be restarted'),
      'firemaps-api.service, worker.service',
    );
    expect(screen.getByLabelText('Allow without approval')).toBeDisabled(); // production
    await user.click(screen.getByRole('button', { name: 'Save policy' }));
    expect(onSave).toHaveBeenCalledWith('host.restart_service', {
      environmentId: 'e-prod',
      enabled: true,
      approverRoles: ['owner', 'admin'],
      requireApproval: true,
      settings: { units: ['firemaps-api.service', 'worker.service'] },
    });
  });

  it('refuses unit names that are not systemd services', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<PolicyList policies={[policy()]} canManage onSave={onSave} />);
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.type(screen.getByLabelText('Units that may be restarted'), 'nginx; reboot');
    await user.click(screen.getByRole('button', { name: 'Save policy' }));
    expect(
      await screen.findByText('nginx; reboot is not a systemd service name such as api.service'),
    ).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('marks capabilities whose connection does not exist yet', () => {
    render(
      <PolicyList
        policies={[
          policy({ capability: 'cloudflare.purge_cache', label: 'Purge Cloudflare cache', available: false }),
        ]}
        canManage
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByText('Needs a Cloudflare connection')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });
});

const action = (over: Partial<ActionRow> = {}): ActionRow => ({
  id: 'a1',
  capability: 'host.restart_service',
  params: { unit: 'firemaps-api.service' },
  host: 'vps-1',
  status: 'pending_approval',
  proposedByAi: false,
  requestedByUserId: 'u-req',
  production: true,
  impactSummary: 'Restarting firemaps-api.service on vps-1 may interrupt 1 dependent: Orders API.',
  createdAt: '2026-10-24T10:00:00Z',
  ...over,
});

describe('ActionList (UC-16-05)', () => {
  it('shows pending requests with the impact, the AI badge, and approve/reject for approvers', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn().mockResolvedValue(undefined);
    render(
      <ActionList
        actions={[action({ proposedByAi: true })]}
        currentUserId="u-approver"
        canApprove
        href={(id) => `/a/${id}`}
        onApprove={onApprove}
        onReject={vi.fn()}
      />,
    );
    const row = screen.getByRole('row', { name: /Restart firemaps-api.service on vps-1/ });
    expect(within(row).getByText('Proposed by AI')).toBeInTheDocument();
    expect(within(row).getByText(/may interrupt 1 dependent: Orders API/)).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Approve' }));
    expect(onApprove).toHaveBeenCalledWith('a1');
  });

  it('hides Approve from the requester in production and from members who cannot approve', () => {
    const { rerender } = render(
      <ActionList
        actions={[action()]}
        currentUserId="u-req"
        canApprove
        href={(id) => id}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.getByText('Waiting for another approver')).toBeInTheDocument();
    rerender(
      <ActionList
        actions={[action()]}
        currentUserId="u-x"
        canApprove={false}
        href={(id) => id}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('asks for a note before rejecting', async () => {
    const user = userEvent.setup();
    const onReject = vi.fn().mockResolvedValue(undefined);
    render(
      <ActionList
        actions={[action()]}
        currentUserId="u-x"
        canApprove
        href={(id) => id}
        onApprove={vi.fn()}
        onReject={onReject}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    await user.click(screen.getByRole('button', { name: 'Confirm rejection' }));
    expect(await screen.findByText('Say why')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Why'), 'Not during peak');
    await user.click(screen.getByRole('button', { name: 'Confirm rejection' }));
    expect(onReject).toHaveBeenCalledWith('a1', 'Not during peak');
  });
});

const detail = (over: Partial<ActionDetailData> = {}): ActionDetailData => ({
  ...action(),
  status: 'failed',
  reason: 'firemaps-api.service is failed after restart',
  approvals: [
    { id: 'p1', userId: 'u-approver', decision: 'approve', note: 'go', createdAt: '2026-10-24T10:02:00Z' },
  ],
  executions: [
    {
      id: 'x1',
      location: 'agent',
      adapter: 'host.restart_service',
      adapterVersion: '0.3.0',
      status: 'failed',
      startedAt: '2026-10-24T10:02:01Z',
      finishedAt: '2026-10-24T10:02:40Z',
      verification: { activeState: 'failed', verified: false },
      error: 'firemaps-api.service is failed after restart',
    },
  ],
  ...over,
});

describe('ActionDetail (UC-16-09)', () => {
  it('shows the timeline and the failed verification with its reason', () => {
    render(<ActionDetail action={detail()} />);
    const timeline = screen.getByRole('list', { name: 'Timeline' });
    expect(within(timeline).getByText(/Proposed/)).toBeInTheDocument();
    expect(within(timeline).getByText(/Approved/)).toBeInTheDocument();
    expect(within(timeline).getByText(/Executed on the host by pcp-helper/)).toBeInTheDocument();
    expect(screen.getByText('Verification failed: the unit is failed')).toBeInTheDocument();
    expect(
      screen.getByText('firemaps-api.service is failed after restart', { selector: 'p' }),
    ).toBeInTheDocument();
  });
});

describe('ProposeDialog (UC-16-02)', () => {
  it('offers only allowlisted units for the chosen host and submits the proposal', async () => {
    const { ProposeDialog } = await import('./propose-dialog');
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <ProposeDialog
        hosts={[
          { agentId: 'ag-1', hostname: 'vps-1', environmentId: 'e-prod' },
          { agentId: 'ag-2', hostname: 'qa-1', environmentId: 'e-qa' },
        ]}
        unitsByEnvironment={{ 'e-prod': ['firemaps-api.service'], 'e-qa': [] }}
        onSubmit={onSubmit}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Propose restart' }));
    await user.selectOptions(screen.getByLabelText('Host'), 'ag-2');
    expect(
      screen.getByText('No units are enabled for this environment; edit its policy first.'),
    ).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Host'), 'ag-1');
    await user.selectOptions(screen.getByLabelText('Service'), 'firemaps-api.service');
    await user.type(screen.getByLabelText('Reason'), 'Stuck after deploy');
    await user.click(screen.getByRole('button', { name: 'Send for approval' }));
    expect(onSubmit).toHaveBeenCalledWith({
      agentId: 'ag-1',
      environmentId: 'e-prod',
      unit: 'firemaps-api.service',
      reason: 'Stuck after deploy',
    });
  });
});
