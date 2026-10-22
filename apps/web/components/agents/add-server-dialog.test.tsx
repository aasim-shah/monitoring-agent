// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@pcp/api-client';
import { AddServerDialog } from './add-server-dialog';

afterEach(cleanup);

const environments = [
  { id: 'e1', name: 'production' },
  { id: 'e2', name: 'staging' },
];
const created = {
  token: 'pcp_enr_secret',
  installCommand: 'curl ... --token pcp_enr_secret --control-url https://agent',
  expiresAt: '2026-10-22T13:00:00Z',
  maxUses: 3,
};

describe('AddServerDialog', () => {
  it('creates an enrollment for the chosen environment and fleet size, then shows the command once', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue(created);
    render(<AddServerDialog environments={environments} onCreate={onCreate} connected={[]} />);
    await user.click(screen.getByRole('button', { name: 'Add server' }));
    await user.selectOptions(screen.getByLabelText('Environment'), 'e2');
    await user.clear(screen.getByLabelText('How many servers?'));
    await user.type(screen.getByLabelText('How many servers?'), '3');
    await user.click(screen.getByRole('button', { name: 'Create install command' }));
    expect(onCreate).toHaveBeenCalledWith({ environmentId: 'e2', maxUses: 3, expiresInMinutes: 60 });
    expect(await screen.findByText(created.installCommand)).toBeInTheDocument();
    expect(screen.getByText(/Waiting for servers/)).toBeInTheDocument();
  });

  it('forgets the token when closed (shown once)', async () => {
    const user = userEvent.setup();
    render(
      <AddServerDialog
        environments={environments}
        onCreate={vi.fn().mockResolvedValue(created)}
        connected={[]}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Add server' }));
    await user.click(screen.getByRole('button', { name: 'Create install command' }));
    await screen.findByText(created.installCommand);
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await user.click(screen.getByRole('button', { name: 'Add server' }));
    expect(screen.queryByText(created.installCommand)).toBeNull();
    expect(screen.getByRole('button', { name: 'Create install command' })).toBeInTheDocument();
  });

  it('announces servers that connected after the command was created', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <AddServerDialog
        environments={environments}
        onCreate={vi.fn().mockResolvedValue(created)}
        connected={[]}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Add server' }));
    await user.click(screen.getByRole('button', { name: 'Create install command' }));
    await screen.findByText(created.installCommand);
    rerender(<AddServerDialog environments={environments} onCreate={vi.fn()} connected={['api-vps-1']} />);
    expect(screen.getByText('Connected: api-vps-1')).toBeInTheDocument();
  });

  it('asks for an environment first when the product has none', async () => {
    const user = userEvent.setup();
    render(<AddServerDialog environments={[]} onCreate={vi.fn()} connected={[]} />);
    await user.click(screen.getByRole('button', { name: 'Add server' }));
    expect(screen.getByText(/Add an environment/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create install command' })).toBeNull();
  });

  it('shows the API message on failure', async () => {
    const user = userEvent.setup();
    const onCreate = vi
      .fn()
      .mockRejectedValue(
        new ApiError(
          503,
          'agent_enrollment_unavailable',
          'Agent enrollment is not configured on this deployment',
        ),
      );
    render(<AddServerDialog environments={environments} onCreate={onCreate} connected={[]} />);
    await user.click(screen.getByRole('button', { name: 'Add server' }));
    await user.click(screen.getByRole('button', { name: 'Create install command' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Agent enrollment is not configured');
  });

  it('warns when the control URL cannot be reached from another machine', async () => {
    const user = userEvent.setup();
    const local = {
      ...created,
      installCommand: 'curl ... --token t --control-url https://agent.localhost:8490',
    };
    render(
      <AddServerDialog
        environments={environments}
        onCreate={vi.fn().mockResolvedValue(local)}
        connected={[]}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Add server' }));
    await user.click(screen.getByRole('button', { name: 'Create install command' }));
    expect(await screen.findByText(/Remote servers cannot reach/)).toBeInTheDocument();
  });

  it('does not warn for a public control URL', async () => {
    const user = userEvent.setup();
    render(
      <AddServerDialog
        environments={environments}
        onCreate={vi.fn().mockResolvedValue(created)}
        connected={[]}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Add server' }));
    await user.click(screen.getByRole('button', { name: 'Create install command' }));
    await screen.findByText(created.installCommand);
    expect(screen.queryByText(/Remote servers cannot reach/)).toBeNull();
  });
});
