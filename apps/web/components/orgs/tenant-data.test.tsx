// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeleteOrganization, DeletionBanner, ExportCard } from './tenant-data';

afterEach(cleanup);

describe('export card (WB-17 UC-17-09)', () => {
  it('requests an export and lists ready, queued, and expired ones; only ready ones download', async () => {
    const user = userEvent.setup();
    const onExport = vi.fn().mockResolvedValue(undefined);
    render(
      <ExportCard
        exports={[
          {
            id: 'e1',
            status: 'ready',
            sizeBytes: 2048,
            error: null,
            expiresAt: '2026-10-26T10:00:00Z',
            createdAt: '2026-10-25T10:00:00Z',
          },
          {
            id: 'e2',
            status: 'queued',
            sizeBytes: null,
            error: null,
            expiresAt: null,
            createdAt: '2026-10-25T11:00:00Z',
          },
          {
            id: 'e3',
            status: 'expired',
            sizeBytes: 900,
            error: null,
            expiresAt: '2026-10-24T10:00:00Z',
            createdAt: '2026-10-23T10:00:00Z',
          },
        ]}
        downloadHref={(id) => `/api/v1/organizations/o/export/${id}/download`}
        onExport={onExport}
      />,
    );
    expect(screen.getByText(/no passwords, tokens, or other credentials/i)).toBeInTheDocument();
    const rows = screen.getAllByRole('listitem');
    expect(within(rows[0]!).getByRole('link', { name: /Download/ })).toHaveAttribute(
      'href',
      '/api/v1/organizations/o/export/e1/download',
    );
    expect(within(rows[1]!).queryByRole('link')).toBeNull();
    expect(rows[1]).toHaveTextContent('Being prepared');
    expect(rows[2]).toHaveTextContent('Link expired');
    await user.click(screen.getByRole('button', { name: 'Export data' }));
    expect(onExport).toHaveBeenCalled();
  });
});

describe('delete organization (WB-17 UC-17-09)', () => {
  it('needs the exact name typed before it can be confirmed, and explains the 30 days', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn().mockResolvedValue(undefined);
    render(<DeleteOrganization name="Acme" onDelete={onDelete} />);
    await user.click(screen.getByRole('button', { name: 'Delete organization' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('After 30 days all data is purged');
    const confirm = screen.getByRole('button', { name: 'Delete Acme' });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText('Type the organization name to confirm'), 'acme');
    expect(confirm).toBeDisabled();
    await user.clear(screen.getByLabelText('Type the organization name to confirm'));
    await user.type(screen.getByLabelText('Type the organization name to confirm'), 'Acme');
    await user.click(confirm);
    expect(onDelete).toHaveBeenCalledWith('Acme');
  });
});

describe('pending deletion banner', () => {
  it('names the purge date and lets the owner cancel', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn().mockResolvedValue(undefined);
    render(<DeletionBanner scheduledFor="2026-11-24T10:00:00Z" canCancel onCancel={onCancel} />);
    expect(screen.getByRole('alert')).toHaveTextContent('scheduled for deletion on 24 Nov 2026');
    await user.click(screen.getByRole('button', { name: 'Cancel deletion' }));
    expect(onCancel).toHaveBeenCalled();
  });
});
