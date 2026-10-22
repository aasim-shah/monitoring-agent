// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AddDatabaseDialog } from './add-database-dialog';
import { DatabaseList, type DatabaseRow } from './database-list';

afterEach(cleanup);

const workers = [{ id: 'w1', hostname: 'db-worker', status: 'active' }];

describe('AddDatabaseDialog (WB-07 UC-07-02)', () => {
  it('never asks for a password and saves a secretRef with the worker', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<AddDatabaseDialog workers={workers} onSubmit={onSubmit} />);
    await user.click(screen.getByRole('button', { name: 'Add database' }));
    expect(screen.queryByLabelText(/password/i)).toBeNull();
    await user.click(screen.getByLabelText('Name'));
    await user.paste('Orders DB');
    await user.click(screen.getByLabelText('Host'));
    await user.paste('10.0.0.5');
    await user.click(screen.getByLabelText('Database'));
    await user.paste('orders');
    expect(screen.getByLabelText('Secret name')).toHaveValue('postgres-orders-db');
    // The read-only user and the secret file are explained, with the password only in the file on the server.
    expect(screen.getByText(/CREATE ROLE pcp_monitor LOGIN/)).toBeInTheDocument();
    expect(screen.getByText(/\/etc\/pcp-worker\/secrets\/postgres-orders-db\.yaml/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save and validate' }));
    expect(onSubmit).toHaveBeenCalledWith({
      provider: 'postgres',
      displayName: 'Orders DB',
      executionLocation: 'private',
      config: {
        workerAgentId: 'w1',
        secretRef: 'postgres-orders-db',
        host: '10.0.0.5',
        port: 5432,
        database: 'orders',
        tls: true,
      },
    });
  });

  it('shows the read-only user steps for each engine', async () => {
    const user = userEvent.setup();
    render(<AddDatabaseDialog workers={workers} onSubmit={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Add database' }));
    await user.selectOptions(screen.getByLabelText('Engine'), 'mongodb');
    expect(screen.getByText(/clusterMonitor/)).toBeInTheDocument();
    expect(screen.getByLabelText('Port')).toHaveValue('27017');
    await user.selectOptions(screen.getByLabelText('Engine'), 'mysql');
    expect(screen.getByText(/GRANT SELECT, PROCESS, REPLICATION CLIENT/)).toBeInTheDocument();
  });

  it('requires an explicit choice to connect without TLS', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<AddDatabaseDialog workers={workers} onSubmit={onSubmit} />);
    await user.click(screen.getByRole('button', { name: 'Add database' }));
    await user.click(screen.getByLabelText('Name'));
    await user.paste('Legacy');
    await user.click(screen.getByLabelText('Host'));
    await user.paste('10.0.0.9');
    await user.click(screen.getByLabelText('Use TLS'));
    await user.click(screen.getByRole('button', { name: 'Save and validate' }));
    expect(await screen.findByText(/Confirm plaintext/)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
    await user.click(screen.getByLabelText(/Allow plaintext on this private network/));
    await user.click(screen.getByRole('button', { name: 'Save and validate' }));
    expect(onSubmit.mock.calls[0]![0].config).toMatchObject({ tls: false, allowInsecure: true });
  });

  it('asks for a private worker first when there is none', async () => {
    const user = userEvent.setup();
    render(<AddDatabaseDialog workers={[]} onSubmit={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Add database' }));
    expect(screen.getByText(/Add a private worker first/)).toBeInTheDocument();
  });
});

const row = (overrides: Partial<DatabaseRow>): DatabaseRow => ({
  id: 'c1',
  displayName: 'Orders DB',
  provider: 'postgres',
  status: 'connected',
  statusReason: null,
  health: {
    connections: 12,
    maxConnections: 100,
    replicationLagSeconds: null,
    databases: [{ name: 'orders', bytes: 5 * 1024 * 1024 }],
    slowQueries: 'extension not installed',
  },
  ...overrides,
});

describe('DatabaseList', () => {
  it('shows health for a connected database', () => {
    render(<DatabaseList rows={[row({})]} canConfigure onOverride={vi.fn()} />);
    const r = screen.getByRole('row', { name: /Orders DB/ });
    expect(within(r).getByText('Connected')).toBeInTheDocument();
    expect(within(r).getByText('12 / 100')).toBeInTheDocument();
    expect(within(r).getByText('5.0 MB')).toBeInTheDocument();
    expect(within(r).getByText('extension not installed')).toBeInTheDocument();
  });

  it('explains permission_denied and offers the audited override only to configurers', async () => {
    const user = userEvent.setup();
    const onOverride = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <DatabaseList
        rows={[row({ status: 'degraded', statusReason: 'permission_denied', health: null })]}
        canConfigure
        onOverride={onOverride}
      />,
    );
    expect(screen.getByText(/can write/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Allow anyway' }));
    expect(onOverride).toHaveBeenCalledWith('c1');
    rerender(
      <DatabaseList
        rows={[row({ status: 'degraded', statusReason: 'permission_denied', health: null })]}
        canConfigure={false}
        onOverride={onOverride}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Allow anyway' })).toBeNull();
  });

  it('shows a worker that is offline, never zeros', () => {
    render(
      <DatabaseList
        rows={[row({ status: 'degraded', statusReason: 'worker_offline' })]}
        canConfigure
        onOverride={vi.fn()}
      />,
    );
    expect(screen.getByText('Worker offline')).toBeInTheDocument();
    expect(screen.queryByText('12 / 100')).toBeNull();
  });

  it('shows validation in progress', () => {
    render(
      <DatabaseList
        rows={[row({ status: 'pending_validation', health: null })]}
        canConfigure
        onOverride={vi.fn()}
      />,
    );
    expect(screen.getByText('Validating…')).toBeInTheDocument();
  });
});
