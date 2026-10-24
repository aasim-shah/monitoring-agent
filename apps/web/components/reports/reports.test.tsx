// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReportList, type ReportRow } from './report-list';
import { ReportView, type ReportData } from './report-view';
import { ScheduleDialog } from './schedule-dialog';
import { ScheduleList, type ScheduleRow } from './schedule-list';

afterEach(cleanup);

const channels = [
  { id: 'c1', name: 'Ops email', kind: 'email' as const },
  { id: 'c2', name: 'Team Slack', kind: 'slack' as const },
];
const preview = vi.fn(async () => ({
  nextRunAt: '2026-10-26T07:00:00.000Z',
  localDate: '2026-10-25',
  windowHours: 25,
}));

describe('ScheduleDialog (WB-15 UC-15-01)', () => {
  it('previews the next run in local time and UTC, validates, and submits', async () => {
    // No per-key delay: the form is long and the suite runs in parallel with the others.
    const user = userEvent.setup({ delay: null });
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <ScheduleDialog
        channels={channels}
        defaultTimezone="Europe/Berlin"
        onPreview={preview}
        onSubmit={onSubmit}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Add schedule' }));
    expect(
      await screen.findByText(/Next run: Mon 26 Oct,? 08:00 \(07:00 UTC\) · covers 25 h/),
    ).toBeInTheDocument();
    expect(preview).toHaveBeenCalledWith('Europe/Berlin', '08:00');

    await user.click(screen.getByRole('button', { name: 'Save schedule' }));
    expect(await screen.findByText('Enter a name')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Name'), 'Daily summary');
    await user.click(screen.getByRole('button', { name: 'Save schedule' }));
    expect(await screen.findByText('Choose a channel or add a recipient')).toBeInTheDocument();
    // Pasted: typing 11 addresses key by key is slow under a loaded test run.
    await user.click(screen.getByLabelText('Recipients'));
    await user.paste(Array.from({ length: 11 }, (_, i) => `r${i}@example.com`).join(', '));
    await user.click(screen.getByRole('button', { name: 'Save schedule' }));
    expect(await screen.findByText('At most 10 recipients')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Recipients'));
    await user.type(screen.getByLabelText('Recipients'), 'cto@example.com');
    await user.click(screen.getByLabelText('Ops email'));
    await user.clear(screen.getByLabelText('Local time'));
    await user.type(screen.getByLabelText('Local time'), '7:5');
    await user.click(screen.getByRole('button', { name: 'Save schedule' }));
    expect(await screen.findByText('Use a 24-hour time such as 08:00')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Local time'));
    await user.type(screen.getByLabelText('Local time'), '08:00');
    await user.click(screen.getByRole('button', { name: 'Save schedule' }));
    expect(onSubmit).toHaveBeenCalledWith({
      name: 'Daily summary',
      timezone: 'Europe/Berlin',
      localTime: '08:00',
      channelIds: ['c1'],
      recipients: ['cto@example.com'],
    });
  }, 60_000);
});

const schedule = (over: Partial<ScheduleRow> = {}): ScheduleRow => ({
  id: 's1',
  name: 'Daily summary',
  timezone: 'Europe/Berlin',
  localTime: '08:00',
  channelIds: ['c1'],
  recipients: ['cto@example.com'],
  enabled: true,
  nextRunAt: '2026-10-26T07:00:00.000Z',
  ...over,
});

describe('ScheduleList', () => {
  it('shows when, where to, and next run; managers can run, pause, and delete', async () => {
    const user = userEvent.setup();
    const onRun = vi.fn().mockResolvedValue(undefined);
    const onToggle = vi.fn().mockResolvedValue(undefined);
    render(
      <ScheduleList
        schedules={[schedule()]}
        channels={channels}
        canManage
        onRun={onRun}
        onToggle={onToggle}
        onDelete={vi.fn()}
      />,
    );
    const row = screen.getByRole('row', { name: /Daily summary/ });
    expect(within(row).getByText('08:00 Europe/Berlin')).toBeInTheDocument();
    expect(within(row).getByText(/Ops email, cto@example.com/)).toBeInTheDocument();
    expect(within(row).getByText(/07:00 UTC/)).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Run now' }));
    expect(onRun).toHaveBeenCalledWith('s1');
    await user.click(within(row).getByRole('button', { name: 'Pause' }));
    expect(onToggle).toHaveBeenCalledWith('s1', false);
  });

  it('hides management from viewers', () => {
    render(
      <ScheduleList
        schedules={[schedule()]}
        channels={channels}
        canManage={false}
        onRun={vi.fn()}
        onToggle={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Run now' })).toBeNull();
  });
});

describe('ReportList (UC-15-04)', () => {
  it('lists versions with their narrative state and lateness', () => {
    const rows: ReportRow[] = [
      {
        id: 'r2',
        localDate: '2026-10-25',
        version: 2,
        narrativeStatus: 'verified',
        late: false,
        scheduleName: 'Daily summary',
        createdAt: '2026-10-26T09:00:00Z',
      },
      {
        id: 'r1',
        localDate: '2026-10-25',
        version: 1,
        narrativeStatus: 'deferred',
        late: true,
        scheduleName: 'Daily summary',
        createdAt: '2026-10-26T07:20:00Z',
      },
    ];
    render(<ReportList reports={rows} href={(id) => `/r/${id}`} />);
    const v1 = screen.getByRole('row', { name: /2026-10-25 · v1/ });
    expect(within(v1).getByText('Narrative deferred')).toBeInTheDocument();
    expect(within(v1).getByText('Late')).toBeInTheDocument();
    expect(
      within(screen.getByRole('row', { name: /v2/ })).getByRole('link', { name: 'Open' }),
    ).toHaveAttribute('href', '/r/r2');
  });
});

const report = (over: Partial<ReportData> = {}): ReportData => ({
  id: 'r1',
  localDate: '2026-10-25',
  version: 1,
  timezone: 'Europe/Berlin',
  windowStart: '2026-10-24T22:00:00.000Z',
  windowEnd: '2026-10-25T23:00:00.000Z',
  narrative: 'One critical incident is still open [S2].',
  narrativeStatus: 'verified',
  problems: [],
  late: false,
  scheduleName: 'Daily summary',
  snapshot: {
    window: {
      timezone: 'Europe/Berlin',
      localDate: '2026-10-25',
      start: '2026-10-24T22:00:00.000Z',
      end: '2026-10-25T23:00:00.000Z',
      hours: 25,
    },
    sections: [
      {
        id: 'S2',
        key: 'health',
        title: 'Product health',
        status: 'ok',
        data: { opened: 3, resolved: 2, openNow: 1, openCritical: 1 },
      },
      {
        id: 'S3',
        key: 'infrastructure',
        title: 'Infrastructure performance',
        status: 'missing',
        data: null,
        reason: 'No host metrics in this window',
      },
      {
        id: 'S5',
        key: 'analytics',
        title: 'User analytics',
        status: 'missing',
        data: null,
        reason: 'Google Analytics not connected',
      },
      {
        id: 'S12',
        key: 'coverage',
        title: 'Data coverage and missing sources',
        status: 'ok',
        data: [{ source: 'User analytics', status: 'missing', reason: 'Google Analytics not connected' }],
      },
    ],
    anomalies: [],
    actions: [],
    coverage: [{ source: 'User analytics', status: 'missing', reason: 'Google Analytics not connected' }],
  },
  deliveries: [
    {
      id: 'd1',
      kind: 'email',
      target: 'Ops email',
      status: 'sent',
      attempts: 1,
      lastError: null,
      sentAt: '2026-10-26T07:01:00Z',
    },
    {
      id: 'd2',
      kind: 'email',
      target: 'cto@example.com',
      status: 'dead',
      attempts: 5,
      lastError: '550 mailbox unavailable',
      sentAt: null,
    },
  ],
  ...over,
});

describe('ReportView (UC-15-04/06)', () => {
  it('shows sections in order, missing data as missing, citations as links, and the delivery log', () => {
    render(<ReportView report={report()} canManage onRegenerate={vi.fn()} />);
    expect(screen.getByRole('heading', { name: /Daily report — 2026-10-25 · v1/ })).toBeInTheDocument();
    expect(screen.getByText(/25 h local day/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'S2' })).toHaveAttribute('href', '#S2');
    const infra = screen.getByRole('region', { name: 'Infrastructure performance' });
    expect(within(infra).getByText('No data: No host metrics in this window')).toBeInTheDocument();
    expect(within(infra).queryByText(/0 %/)).toBeNull();
    expect(
      within(screen.getByRole('region', { name: 'User analytics' })).getByText(
        'No data: Google Analytics not connected',
      ),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Product health' })).getByText('Open now: 1 (critical: 1)'),
    ).toBeInTheDocument();
    const dead = screen.getByRole('row', { name: /cto@example.com/ });
    expect(within(dead).getByText('Failed')).toBeInTheDocument();
    expect(within(dead).getByText('550 mailbox unavailable')).toBeInTheDocument();
  });

  it('says when the narrative is deferred and lists why', () => {
    render(
      <ReportView
        report={report({
          narrative: null,
          narrativeStatus: 'deferred',
          problems: ['91 does not appear in the evidence'],
        })}
        canManage={false}
        onRegenerate={vi.fn()}
      />,
    );
    expect(
      screen.getByText('Narrative deferred: the AI summary could not be verified against the data.'),
    ).toBeInTheDocument();
    expect(screen.getByText('91 does not appear in the evidence')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Regenerate' })).toBeNull();
  });

  it('regenerates for managers', async () => {
    const user = userEvent.setup();
    const onRegenerate = vi.fn().mockResolvedValue(undefined);
    render(<ReportView report={report()} canManage onRegenerate={onRegenerate} />);
    await user.click(screen.getByRole('button', { name: 'Regenerate' }));
    expect(onRegenerate).toHaveBeenCalled();
  });
});
