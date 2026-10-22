// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AuditTable, type AuditRow } from './audit-table';

const row = (i: number): AuditRow => ({
  id: `id-${i}`,
  action: i === 1 ? 'product.created' : 'organization.created',
  actorType: 'user',
  actorId: 'u-1',
  targetType: 'product',
  targetId: `t-${i}`,
  createdAt: '2026-10-22T08:00:00Z',
});

describe('AuditTable', () => {
  it('renders entries and loads more when a cursor exists', async () => {
    const onLoadMore = vi.fn();
    render(<AuditTable entries={[row(1), row(2)]} hasMore onLoadMore={onLoadMore} loadingMore={false} />);
    expect(screen.getAllByRole('row')).toHaveLength(3); // header + 2
    expect(screen.getByText('product.created')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(onLoadMore).toHaveBeenCalledOnce();
  });

  it('hides "Load more" on the last page', () => {
    render(<AuditTable entries={[row(1)]} hasMore={false} onLoadMore={vi.fn()} loadingMore={false} />);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('shows an empty state', () => {
    render(<AuditTable entries={[]} hasMore={false} onLoadMore={vi.fn()} loadingMore={false} />);
    expect(screen.getByText('No audit entries yet')).toBeInTheDocument();
  });
});
