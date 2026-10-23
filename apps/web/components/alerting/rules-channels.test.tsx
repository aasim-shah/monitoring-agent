// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AddChannelDialog } from './add-channel-dialog';
import { AddRuleDialog } from './add-rule-dialog';
import { ChannelList, type ChannelRow } from './channel-list';
import { RuleList, type AlertTemplate, type RuleRow } from './rule-list';

afterEach(cleanup);

const templates: AlertTemplate[] = [
  {
    id: 'host_cpu_high',
    label: 'Server CPU high',
    description: 'CPU use on a server stays above the threshold.',
    kind: 'metric',
    defaultSeverity: 'warning',
    params: [
      { name: 'threshold', label: 'Above', unit: '%', min: 1, max: 100, default: 90 },
      { name: 'forMinutes', label: 'For at least', unit: 'min', min: 1, max: 1440, default: 10 },
    ],
  },
  {
    id: 'agent_heartbeat_missing',
    label: 'Agent heartbeat missing',
    description: 'An agent has not reported.',
    kind: 'heartbeat',
    defaultSeverity: 'critical',
    params: [{ name: 'minutes', label: 'Silent for', unit: 'min', min: 2, max: 1440, default: 5 }],
  },
];
const rule = (over: Partial<RuleRow> = {}): RuleRow => ({
  id: 'r1',
  name: 'Server CPU high',
  template: 'host_cpu_high',
  params: { threshold: 90, forMinutes: 10 },
  severity: 'warning',
  enabled: true,
  ...over,
});

describe('RuleList (UC-13-01)', () => {
  it('describes each rule in words and toggles or deletes it', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn().mockResolvedValue(undefined);
    const onDelete = vi.fn().mockResolvedValue(undefined);
    render(
      <RuleList
        rules={[rule()]}
        templates={templates}
        canManage
        onToggle={onToggle}
        onDelete={onDelete}
        onAddRecommended={vi.fn()}
      />,
    );
    const r = screen.getByRole('row', { name: /Server CPU high/ });
    expect(within(r).getByText('Above 90 % · For at least 10 min')).toBeInTheDocument();
    expect(within(r).getByText('Warning')).toBeInTheDocument();
    await user.click(within(r).getByRole('switch', { name: 'Enabled' }));
    expect(onToggle).toHaveBeenCalledWith('r1', false);
    await user.click(within(r).getByRole('button', { name: 'Delete' }));
    expect(onDelete).toHaveBeenCalledWith('r1');
  });

  it('offers the recommended rules when there are none, only to managers', async () => {
    const user = userEvent.setup();
    const onAddRecommended = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <RuleList
        rules={[]}
        templates={templates}
        canManage
        onToggle={vi.fn()}
        onDelete={vi.fn()}
        onAddRecommended={onAddRecommended}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Add recommended rules' }));
    expect(onAddRecommended).toHaveBeenCalled();
    rerender(
      <RuleList
        rules={[rule()]}
        templates={templates}
        canManage={false}
        onToggle={vi.fn()}
        onDelete={vi.fn()}
        onAddRecommended={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Add recommended rules' })).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
  });
});

describe('AddRuleDialog', () => {
  it('fills the template defaults, checks the ranges, and submits', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<AddRuleDialog templates={templates} onSubmit={onSubmit} />);
    await user.click(screen.getByRole('button', { name: 'Add rule' }));
    expect(screen.getByLabelText('Above (%)')).toHaveValue(90);
    await user.clear(screen.getByLabelText('Above (%)'));
    await user.type(screen.getByLabelText('Above (%)'), '150');
    await user.click(screen.getByRole('button', { name: 'Save rule' }));
    expect(await screen.findByText('Above must be between 1 and 100')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
    await user.clear(screen.getByLabelText('Above (%)'));
    await user.type(screen.getByLabelText('Above (%)'), '85');
    await user.selectOptions(screen.getByLabelText('Severity'), 'critical');
    await user.click(screen.getByRole('button', { name: 'Save rule' }));
    expect(onSubmit).toHaveBeenCalledWith({
      template: 'host_cpu_high',
      params: { threshold: 85, forMinutes: 10 },
      severity: 'critical',
    });
  });

  it('switches parameters with the template', async () => {
    const user = userEvent.setup();
    render(<AddRuleDialog templates={templates} onSubmit={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Add rule' }));
    await user.selectOptions(screen.getByLabelText('Template'), 'agent_heartbeat_missing');
    expect(screen.getByLabelText('Silent for (min)')).toHaveValue(5);
    expect(screen.getByLabelText('Severity')).toHaveValue('critical');
  });
});

const channel = (over: Partial<ChannelRow> = {}): ChannelRow => ({
  id: 'c1',
  name: 'Ops email',
  kind: 'email',
  recipients: ['ops@example.com'],
  target: null,
  escalation: false,
  status: 'active',
  ...over,
});

describe('ChannelList and AddChannelDialog (UC-13-09)', () => {
  it('lists channels with their target, a broken badge, and a test button', async () => {
    const user = userEvent.setup();
    const onTest = vi.fn().mockResolvedValue(undefined);
    render(
      <ChannelList
        channels={[
          channel(),
          channel({
            id: 'c2',
            name: 'Slack',
            kind: 'slack',
            recipients: null,
            target: 'hooks.slack.com',
            status: 'broken',
          }),
        ]}
        canManage
        onTest={onTest}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByRole('row', { name: /Ops email/ })).toHaveTextContent('ops@example.com');
    const slack = screen.getByRole('row', { name: /Slack/ });
    expect(slack).toHaveTextContent('hooks.slack.com');
    expect(within(slack).getByText('Broken')).toBeInTheDocument();
    await user.click(within(slack).getByRole('button', { name: 'Send test' }));
    expect(onTest).toHaveBeenCalledWith('c2');
  });

  it('creates an email channel from a comma-separated list', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue({});
    render(<AddChannelDialog onSubmit={onSubmit} />);
    await user.click(screen.getByRole('button', { name: 'Add channel' }));
    await user.type(screen.getByLabelText('Name'), 'Ops');
    await user.type(screen.getByLabelText('Recipients'), 'ops@example.com, oncall@example.com');
    await user.click(screen.getByRole('button', { name: 'Save channel' }));
    expect(onSubmit).toHaveBeenCalledWith({
      kind: 'email',
      name: 'Ops',
      recipients: ['ops@example.com', 'oncall@example.com'],
      escalation: false,
    });
  });

  it('shows a webhook signing secret once, with the verification guide', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue({ signingSecret: 'whsec_abcdefghijklmnopqrstuvwxyz012345' });
    render(<AddChannelDialog onSubmit={onSubmit} />);
    await user.click(screen.getByRole('button', { name: 'Add channel' }));
    await user.selectOptions(screen.getByLabelText('Type'), 'webhook');
    await user.type(screen.getByLabelText('Name'), 'Pager');
    await user.type(screen.getByLabelText('URL'), 'https://hooks.example.com/pcp');
    await user.click(screen.getByLabelText(/Escalation channel/));
    await user.click(screen.getByRole('button', { name: 'Save channel' }));
    expect(onSubmit).toHaveBeenCalledWith({
      kind: 'webhook',
      name: 'Pager',
      url: 'https://hooks.example.com/pcp',
      escalation: true,
    });
    expect(await screen.findByText('whsec_abcdefghijklmnopqrstuvwxyz012345')).toBeInTheDocument();
    expect(screen.getByText(/shown only now/)).toBeInTheDocument();
  });

  it('refuses a non-https URL before sending', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<AddChannelDialog onSubmit={onSubmit} />);
    await user.click(screen.getByRole('button', { name: 'Add channel' }));
    await user.selectOptions(screen.getByLabelText('Type'), 'slack');
    await user.type(screen.getByLabelText('Name'), 'Slack');
    await user.type(screen.getByLabelText('URL'), 'http://hooks.slack.com/x');
    await user.click(screen.getByRole('button', { name: 'Save channel' }));
    expect(await screen.findByText('Use an https:// URL')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
