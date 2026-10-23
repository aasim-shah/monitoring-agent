// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IncidentDetail, type IncidentDetailData } from './incident-detail';
import { IncidentList, type IncidentRow } from './incident-list';

afterEach(cleanup);

const NOW = new Date('2026-10-23T10:30:00Z');
const row = (over: Partial<IncidentRow> = {}): IncidentRow => ({
  id: 'i1',
  title: 'Server CPU high on vps-1',
  severity: 'critical',
  status: 'open',
  startedAt: '2026-10-23T10:00:00Z',
  resolvedAt: null,
  ...over,
});

describe('IncidentList (WB-13 §8)', () => {
  it('shows severity, status, age, and links each incident', () => {
    render(
      <IncidentList
        incidents={[
          row(),
          row({
            id: 'i2',
            title: 'Disk almost full on db-1',
            severity: 'warning',
            status: 'resolved',
            resolvedAt: '2026-10-23T10:20:00Z',
          }),
        ]}
        filter="all"
        onFilter={vi.fn()}
        hrefFor={(id) => `/incidents/${id}`}
        now={NOW}
      />,
    );
    const first = screen.getByRole('row', { name: /Server CPU high on vps-1/ });
    expect(within(first).getByText('Critical')).toBeInTheDocument();
    expect(within(first).getByText('Open')).toBeInTheDocument();
    expect(within(first).getByText('30 min')).toBeInTheDocument();
    expect(within(first).getByRole('link', { name: 'Server CPU high on vps-1' })).toHaveAttribute(
      'href',
      '/incidents/i1',
    );
    const second = screen.getByRole('row', { name: /Disk almost full/ });
    expect(within(second).getByText('Resolved')).toBeInTheDocument();
    expect(within(second).getByText('20 min')).toBeInTheDocument();
  });

  it('filters by status and says when nothing matches', async () => {
    const user = userEvent.setup();
    const onFilter = vi.fn();
    render(
      <IncidentList incidents={[]} filter="active" onFilter={onFilter} hrefFor={(id) => id} now={NOW} />,
    );
    expect(screen.getByText(/No active incidents/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Resolved' }));
    expect(onFilter).toHaveBeenCalledWith('resolved');
    expect(screen.getByRole('button', { name: 'Active' })).toHaveAttribute('aria-pressed', 'true');
  });
});

const detail = (over: Partial<IncidentDetailData['incident']> = {}): IncidentDetailData => ({
  incident: {
    id: 'i1',
    title: 'Server CPU high on vps-1',
    severity: 'critical',
    status: 'open',
    summary:
      'Server CPU high on vps-1. Latest value 97.3. Correlated with 2 assets: Orders API (potential), shop.example.com (unknown).',
    startedAt: '2026-10-23T10:00:00Z',
    acknowledgedAt: null,
    resolvedAt: null,
    resolutionNote: null,
    postmortem: null,
    ...over,
  },
  events: [
    { kind: 'fired', at: '2026-10-23T10:00:00Z', detail: { value: '97.3' } },
    { kind: 'notified', at: '2026-10-23T10:00:01Z', detail: { event: 'opened' } },
    { kind: 'escalated', at: '2026-10-23T10:15:00Z', detail: {} },
  ],
  correlation: {
    host: { id: 'h1', name: 'vps-1' },
    assets: [
      { assetId: 'a1', name: 'Orders API', assetType: 'service', impact: 'potential', distance: 1 },
      { assetId: 'a2', name: 'shop.example.com', assetType: 'website', impact: 'unknown', distance: 2 },
    ],
    counts: { potential: 1, unknown: 1 },
  },
  changes: [],
  sourceLinks: [
    { label: 'Server vps-1', href: '/orgs/o/products/p/infrastructure/agent-1' },
    { label: 'Alert rules', href: '/orgs/o/products/p/alert-rules' },
  ],
});

describe('IncidentDetail (Scenario B steps 3 and 6)', () => {
  it('shows the summary, the timeline in order, the blast radius, and source links', () => {
    render(
      <IncidentDetail
        data={detail()}
        canManage
        onAcknowledge={vi.fn()}
        onResolve={vi.fn()}
        onPostmortem={vi.fn()}
      />,
    );
    expect(screen.getByText(/Correlated with 2 assets/)).toBeInTheDocument();
    const items = within(screen.getByRole('list', { name: 'Timeline' })).getAllByRole('listitem');
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining('Alert fired (value 97.3)'),
      expect.stringContaining('Notified: opened'),
      expect.stringContaining('Escalated: unacknowledged for 15 min'),
    ]);
    const blast = screen.getByRole('table', { name: 'Blast radius' });
    expect(within(blast).getByRole('row', { name: /Orders API/ })).toHaveTextContent('Potential');
    expect(within(blast).getByRole('row', { name: /shop.example.com/ })).toHaveTextContent('Unknown');
    expect(screen.getByRole('link', { name: 'Server vps-1' })).toHaveAttribute(
      'href',
      '/orgs/o/products/p/infrastructure/agent-1',
    );
    expect(screen.getByText('No recent changes recorded.')).toBeInTheDocument();
  });

  it('acknowledges an open incident and resolves with a note', async () => {
    const user = userEvent.setup();
    const onAcknowledge = vi.fn().mockResolvedValue(undefined);
    const onResolve = vi.fn().mockResolvedValue(undefined);
    render(
      <IncidentDetail
        data={detail()}
        canManage
        onAcknowledge={onAcknowledge}
        onResolve={onResolve}
        onPostmortem={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Acknowledge' }));
    expect(onAcknowledge).toHaveBeenCalled();
    await user.type(screen.getByLabelText('Resolution note'), 'Restarted the worker');
    await user.click(screen.getByRole('button', { name: 'Resolve' }));
    expect(onResolve).toHaveBeenCalledWith('Restarted the worker');
  });

  it('hides actions without incident.manage and after resolution', () => {
    const { rerender } = render(
      <IncidentDetail
        data={detail()}
        canManage={false}
        onAcknowledge={vi.fn()}
        onResolve={vi.fn()}
        onPostmortem={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Resolve' })).toBeNull();
    rerender(
      <IncidentDetail
        data={detail({ status: 'resolved', resolvedAt: '2026-10-23T10:40:00Z', resolutionNote: 'Fixed' })}
        canManage
        onAcknowledge={vi.fn()}
        onResolve={vi.fn()}
        onPostmortem={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).toBeNull();
    expect(screen.getByText(/Fixed/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save postmortem' })).toBeInTheDocument();
  });

  it('records a postmortem', async () => {
    const user = userEvent.setup();
    const onPostmortem = vi.fn().mockResolvedValue(undefined);
    render(
      <IncidentDetail
        data={detail({ status: 'resolved', resolvedAt: '2026-10-23T10:40:00Z' })}
        canManage
        onAcknowledge={vi.fn()}
        onResolve={vi.fn()}
        onPostmortem={onPostmortem}
      />,
    );
    await user.type(screen.getByLabelText('What happened'), 'Logs filled the disk');
    await user.selectOptions(screen.getByLabelText('Cause category'), 'capacity');
    await user.type(screen.getByLabelText('Follow-ups (one per line)'), 'Rotate logs{enter}Alert at 80 %');
    await user.click(screen.getByRole('button', { name: 'Save postmortem' }));
    expect(onPostmortem).toHaveBeenCalledWith({
      summary: 'Logs filled the disk',
      causeCategory: 'capacity',
      followUps: ['Rotate logs', 'Alert at 80 %'],
    });
  });
});
