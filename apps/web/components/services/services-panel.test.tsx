// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServicesPanel, type CatalogPack } from './services-panel';

afterEach(cleanup);

const catalog: CatalogPack[] = [
  {
    id: 'redis',
    name: 'Redis',
    description: 'Memory and ops',
    defaultEndpoint: '127.0.0.1:6379',
    credentialFields: [
      { name: 'password', label: 'Password (if requirepass is set)', secret: true, required: false },
    ],
  },
  {
    id: 'postgresql',
    name: 'PostgreSQL',
    description: 'Connections',
    defaultEndpoint: '127.0.0.1:5432',
    credentialFields: [
      { name: 'username', label: 'Username', secret: false, required: true },
      { name: 'password', label: 'Password', secret: true, required: true },
    ],
  },
  {
    id: 'nginx',
    name: 'nginx',
    description: 'Requests',
    defaultEndpoint: 'http://127.0.0.1/nginx_status',
    credentialFields: [],
  },
  { id: 'nodejs', name: 'Node.js', description: 'Processes', defaultEndpoint: null, credentialFields: [] },
];

const services = [
  { pack: 'redis', name: 'Redis', ports: [{ address: '127.0.0.1', port: 6379 }], processCount: 1 },
  { pack: 'postgresql', name: 'PostgreSQL', ports: [{ address: '0.0.0.0', port: 5432 }], processCount: 3 },
];
const warnings = [{ pack: 'postgresql', address: '0.0.0.0', port: 5432 }];

function setup(overrides: Partial<Parameters<typeof ServicesPanel>[0]> = {}) {
  const onEnable = vi.fn().mockResolvedValue(undefined);
  const props = {
    catalog,
    services,
    warnings,
    assignments: [
      { packId: 'redis', status: 'failed' as const, statusMessage: 'receivers::redis: missing port' },
    ],
    canManage: true,
    seal: vi.fn().mockResolvedValue('SEALED-CIPHERTEXT'),
    onEnable,
    onDisable: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  render(<ServicesPanel {...props} />);
  return { ...props, onEnable };
}

const row = (name: string) => screen.getByRole('row', { name: new RegExp(name) });

describe('ServicesPanel (WB-11)', () => {
  it('lists detected services with ports, exposure warnings, and pack status', () => {
    setup({
      assignments: [
        { packId: 'redis', status: 'applied', statusMessage: null },
        { packId: 'nginx', status: 'pending', statusMessage: null },
      ],
    });
    expect(within(row('Redis')).getByText('127.0.0.1:6379')).toBeInTheDocument();
    expect(within(row('Redis')).getByText('Monitoring')).toBeInTheDocument();
    expect(within(row('PostgreSQL')).getByText('Not monitored')).toBeInTheDocument();
    expect(
      within(row('PostgreSQL')).getByText(/Exposed to the internet on 0\.0\.0\.0:5432/),
    ).toBeInTheDocument();
    // Enabled but not detected still shows.
    expect(within(row('nginx')).getByText('Applying…')).toBeInTheDocument();
  });

  it('shows why a pack failed', () => {
    setup();
    expect(within(row('Redis')).getByText(/receivers::redis: missing port/)).toBeInTheDocument();
  });

  it('seals credentials in the browser; the request body never holds the password', async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.click(within(row('PostgreSQL')).getByRole('button', { name: 'Monitor' }));
    expect(screen.getByLabelText('Endpoint')).toHaveValue('127.0.0.1:5432');
    // Paste instead of type: per-key events are slow in jsdom.
    await user.click(screen.getByLabelText('Username'));
    await user.paste('pcp_monitor');
    await user.click(screen.getByLabelText('Password'));
    await user.paste('hunter2-secret');
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
    await user.click(screen.getByRole('button', { name: 'Start monitoring' }));
    expect(props.seal).toHaveBeenCalledWith({ username: 'pcp_monitor', password: 'hunter2-secret' });
    expect(props.onEnable).toHaveBeenCalledWith({
      packId: 'postgresql',
      settings: { endpoint: '127.0.0.1:5432' },
      sealedCredentials: 'SEALED-CIPHERTEXT',
    });
    expect(JSON.stringify(props.onEnable.mock.calls)).not.toContain('hunter2');
  });

  it('requires required credentials and sends none when a pack has none', async () => {
    const user = userEvent.setup();
    const props = setup({ assignments: [] });
    await user.click(within(row('PostgreSQL')).getByRole('button', { name: 'Monitor' }));
    await user.click(screen.getByRole('button', { name: 'Start monitoring' }));
    expect(await screen.findByText('Username is required')).toBeInTheDocument();
    expect(props.onEnable).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Close' }));

    await user.selectOptions(screen.getByLabelText('Monitor another service'), 'nodejs');
    await user.click(screen.getByRole('button', { name: 'Start monitoring' }));
    expect(props.seal).not.toHaveBeenCalled();
    expect(props.onEnable).toHaveBeenCalledWith({ packId: 'nodejs', settings: {} });
  });

  it('stops monitoring', async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.click(within(row('Redis')).getByRole('button', { name: 'Stop monitoring' }));
    expect(props.onDisable).toHaveBeenCalledWith('redis');
  });

  it('hides controls without pack.manage', () => {
    setup({ canManage: false });
    expect(screen.queryByRole('button', { name: 'Monitor' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stop monitoring' })).toBeNull();
    expect(screen.queryByLabelText('Monitor another service')).toBeNull();
  });

  it('explains an empty inventory', () => {
    setup({ services: [], warnings: [], assignments: [] });
    expect(screen.getByText(/No supported services detected yet/)).toBeInTheDocument();
  });
});
