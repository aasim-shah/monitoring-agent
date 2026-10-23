// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toFlow } from '@/lib/topology';
import { ImpactList } from './impact-list';
import { InventoryTable, type AssetRow } from './inventory-table';
import { ReviewQueue, type ReviewEdge } from './review-queue';

afterEach(cleanup);

const nodes = [
  { id: 'w', name: 'shop.example', assetType: 'website', lifecycle: 'active' },
  { id: 'h', name: 'vps-1', assetType: 'host', lifecycle: 'active' },
  { id: 'r', name: 'Redis', assetType: 'service', lifecycle: 'active' },
  { id: 'd', name: 'Orders DB', assetType: 'database', lifecycle: 'missing' },
];
const edges = [
  { id: 'e1', source: 'h', target: 'r', type: 'HOSTS', verification: 'verified', confidence: 0.95 },
  { id: 'e2', source: 'w', target: 'h', type: 'ROUTES_TO', verification: 'proposed', confidence: 0.8 },
  { id: 'e3', source: 'd', target: 'h', type: 'DEPLOYED_ON', verification: 'drifted', confidence: 0.8 },
];

describe('toFlow (topology layout)', () => {
  it('lays out websites above hosts above services and databases', () => {
    const flow = toFlow(nodes, edges);
    const y = Object.fromEntries(flow.nodes.map((n) => [n.id, n.position.y]));
    expect(y.w).toBeLessThan(y.h!);
    expect(y.h).toBeLessThan(y.r!);
    expect(y.r).toBe(y.d);
    expect(flow.nodes.find((n) => n.id === 'd')!.data.label).toContain('missing');
  });

  it('styles edges by verification: solid, dashed, amber', () => {
    const e = Object.fromEntries(toFlow(nodes, edges).edges.map((x) => [x.id, x]));
    expect(e.e1!.style?.strokeDasharray).toBeUndefined();
    expect(e.e2!.style?.strokeDasharray).toBeDefined();
    expect(String(e.e3!.style?.stroke)).toContain('amber');
    expect(e.e2!.label).toBe('ROUTES_TO · 80%');
  });
});

const reviewEdge = (id: string, verification: 'proposed' | 'drifted' = 'proposed'): ReviewEdge => ({
  id,
  type: 'ROUTES_TO',
  verification,
  confidence: 0.8,
  ruleId: 'dns-to-host',
  source: { id: 'w', name: 'shop.example', assetType: 'website' },
  target: { id: 'h', name: 'vps-1', assetType: 'host' },
  evidence: [{ kind: 'ip_match', detail: { ip: '203.0.113.7' }, observedAt: '2026-10-23T10:00:00Z' }],
  updatedAt: '2026-10-23T10:00:00Z',
});

describe('ReviewQueue (UC-10-04)', () => {
  it('confirms and rejects edges, and resolves aliases', async () => {
    const user = userEvent.setup();
    const props = {
      edges: [reviewEdge('e1'), reviewEdge('e2', 'drifted')],
      aliases: [
        {
          id: 'a1',
          reason: 'same name "vps-1"',
          asset: { id: 'x', name: 'vps-1', assetType: 'host' },
          candidate: { id: 'y', name: 'vps-1', assetType: 'host' },
          createdAt: '2026-10-23T10:00:00Z',
        },
      ],
      canVerify: true,
      canManage: true,
      onVerify: vi.fn().mockResolvedValue(undefined),
      onReject: vi.fn().mockResolvedValue(undefined),
      onResolve: vi.fn().mockResolvedValue(undefined),
    };
    render(<ReviewQueue {...props} />);
    const first = screen.getAllByRole('listitem')[0]!;
    expect(within(first).getByText(/shop\.example → vps-1/)).toBeInTheDocument();
    expect(within(first).getByText(/ip_match/)).toBeInTheDocument();
    await user.click(within(first).getByRole('button', { name: 'Confirm' }));
    expect(props.onVerify).toHaveBeenCalledWith('e1');
    await user.click(within(screen.getAllByRole('listitem')[1]!).getByRole('button', { name: 'Reject' }));
    expect(props.onReject).toHaveBeenCalledWith('e2');
    expect(screen.getByText('Drifted')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Merge' }));
    expect(props.onResolve).toHaveBeenCalledWith('a1', 'merge');
  });

  it('hides actions without permission and explains an empty queue', () => {
    const { rerender } = render(
      <ReviewQueue
        edges={[reviewEdge('e1')]}
        aliases={[]}
        canVerify={false}
        canManage={false}
        onVerify={vi.fn()}
        onReject={vi.fn()}
        onResolve={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
    rerender(
      <ReviewQueue
        edges={[]}
        aliases={[]}
        canVerify
        canManage
        onVerify={vi.fn()}
        onReject={vi.fn()}
        onResolve={vi.fn()}
      />,
    );
    expect(screen.getByText(/Nothing to review/)).toBeInTheDocument();
  });
});

const asset = (id: string, name: string, assetType: string, lifecycle = 'active'): AssetRow => ({
  id,
  name,
  assetType,
  lifecycle,
  source: 'agent',
  lastSeenAt: '2026-10-23T10:00:00Z',
});

describe('InventoryTable', () => {
  it('filters by type and links to asset detail', async () => {
    const user = userEvent.setup();
    render(
      <InventoryTable
        assets={[
          asset('1', 'vps-1', 'host'),
          asset('2', 'Redis', 'service'),
          asset('3', 'old-db', 'database', 'missing'),
        ]}
        basePath="/orgs/o/products/p/assets"
      />,
    );
    expect(screen.getAllByRole('row')).toHaveLength(4);
    await user.selectOptions(screen.getByLabelText('Type'), 'service');
    expect(screen.getAllByRole('row')).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'Redis' })).toHaveAttribute(
      'href',
      '/orgs/o/products/p/assets/2',
    );
  });
});

describe('ImpactList (UC-10-10)', () => {
  it('shows each dependent with its class and path', () => {
    render(
      <ImpactList
        impact={[
          {
            assetId: '1',
            name: 'Redis',
            assetType: 'service',
            distance: 1,
            impact: 'potential',
            via: ['vps-1', 'Redis'],
          },
          {
            assetId: '2',
            name: 'Orders DB',
            assetType: 'database',
            distance: 1,
            impact: 'confirmed',
            via: ['vps-1', 'Orders DB'],
          },
          {
            assetId: '3',
            name: 'shop.example',
            assetType: 'website',
            distance: 2,
            impact: 'unknown',
            via: ['vps-1', 'x', 'shop.example'],
          },
        ]}
      />,
    );
    expect(within(screen.getByRole('row', { name: /Orders DB/ })).getByText('Confirmed')).toBeInTheDocument();
    expect(within(screen.getByRole('row', { name: /Redis/ })).getByText('Potential')).toBeInTheDocument();
    expect(
      within(screen.getByRole('row', { name: /shop\.example/ })).getByText('vps-1 → x → shop.example'),
    ).toBeInTheDocument();
  });

  it('says when nothing depends on the asset', () => {
    render(<ImpactList impact={[]} />);
    expect(screen.getByText(/Nothing depends on this asset/)).toBeInTheDocument();
  });
});
