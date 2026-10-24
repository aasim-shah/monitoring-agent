// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssistedInstallDialog, type InstallSessionView, type AssistedInstallApi } from './assisted-install';

afterEach(cleanup);

const environments = [{ id: 'e1', name: 'production' }];
const base: InstallSessionView = {
  id: 's1',
  mode: 'key',
  status: 'awaiting_key',
  expiresAt: '2026-10-25T12:00:00Z',
  publicKey: 'ssh-ed25519 AAAAkey pcp-install-s1',
  setupCommand:
    "sudo useradd -m -s /bin/bash pcp-install && echo 'ssh-ed25519 AAAAkey pcp-install-s1' | sudo tee ...",
  egressIps: ['203.0.113.7'],
  hosts: [
    {
      id: 'h1',
      host: '198.51.100.10',
      port: 22,
      username: 'pcp-install',
      fingerprint: null,
      fingerprintConfirmedAt: null,
      status: 'pending',
      output: '',
      scriptVersion: null,
      cleanup: null,
      error: null,
    },
  ],
};

function fakeApi(over: Partial<AssistedInstallApi> = {}): AssistedInstallApi {
  return {
    create: vi.fn().mockResolvedValue(base),
    connect: vi.fn().mockResolvedValue(undefined),
    confirm: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(base),
    abort: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

describe('AssistedInstallDialog (UC-05-05)', () => {
  it('starts a key session, shows the key command and egress IPs, and connects', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    render(<AssistedInstallDialog environments={environments} api={api} pollMs={0} />);
    await user.click(screen.getByRole('button', { name: 'Assisted install' }));
    await user.type(screen.getByLabelText('Servers'), '198.51.100.10\nweb-2.example.com:2222');
    await user.click(screen.getByRole('button', { name: 'Start session' }));
    expect(api.create).toHaveBeenCalledWith('e1', {
      mode: 'key',
      hosts: [
        { host: '198.51.100.10', port: 22 },
        { host: 'web-2.example.com', port: 2222 },
      ],
    });
    expect(await screen.findByText(base.setupCommand!)).toBeInTheDocument();
    expect(screen.getByText(/203\.0\.113\.7/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Key added, connect' }));
    expect(api.connect).toHaveBeenCalledWith('s1', undefined);
  });

  it('TC-05-06: installs a host only after its fingerprint is confirmed', async () => {
    const user = userEvent.setup();
    const awaiting: InstallSessionView = {
      ...base,
      status: 'awaiting_confirmation',
      hosts: [{ ...base.hosts[0]!, status: 'awaiting_confirmation', fingerprint: 'SHA256:abc' }],
    };
    const api = fakeApi({ get: vi.fn().mockResolvedValue(awaiting) });
    render(<AssistedInstallDialog environments={environments} api={api} pollMs={0} />);
    await user.click(screen.getByRole('button', { name: 'Assisted install' }));
    await user.type(screen.getByLabelText('Servers'), '198.51.100.10');
    await user.click(screen.getByRole('button', { name: 'Start session' }));
    await user.click(await screen.findByRole('button', { name: 'Key added, connect' }));
    expect(await screen.findByText('SHA256:abc')).toBeInTheDocument();
    expect(api.confirm).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Fingerprint matches, install on 198.51.100.10' }));
    expect(api.confirm).toHaveBeenCalledWith('s1', 'h1', 'SHA256:abc');
  });

  it('password mode sends the password once, clears it, and asks to rotate it after install', async () => {
    const user = userEvent.setup();
    const pw: InstallSessionView = {
      ...base,
      mode: 'password',
      publicKey: null,
      setupCommand: null,
      hosts: [{ ...base.hosts[0]!, username: 'admin' }],
    };
    const installed: InstallSessionView = {
      ...pw,
      status: 'completed',
      hosts: [
        { ...pw.hosts[0]!, status: 'installed', cleanup: 'not_needed', output: 'pcp-agent 0.4.0 is running' },
      ],
    };
    const api = fakeApi({ create: vi.fn().mockResolvedValue(pw), get: vi.fn().mockResolvedValue(installed) });
    render(<AssistedInstallDialog environments={environments} api={api} pollMs={0} />);
    await user.click(screen.getByRole('button', { name: 'Assisted install' }));
    await user.click(screen.getByLabelText('Password (last resort)'));
    await user.type(screen.getByLabelText('Servers'), '198.51.100.10');
    await user.type(screen.getByLabelText('User name'), 'admin');
    await user.click(screen.getByRole('button', { name: 'Start session' }));
    expect(api.create).toHaveBeenCalledWith('e1', {
      mode: 'password',
      hosts: [{ host: '198.51.100.10', port: 22, username: 'admin' }],
    });
    await user.type(await screen.findByLabelText('Password'), 'hunter2');
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(api.connect).toHaveBeenCalledWith('s1', 'hunter2');
    expect(await screen.findByText(/Rotate the password/)).toBeInTheDocument();
    expect(screen.queryByDisplayValue('hunter2')).toBeNull();
    expect(screen.getByText('pcp-agent 0.4.0 is running')).toBeInTheDocument();
  });

  it('shows the manual cleanup commands when cleanup could not be confirmed, and aborts', async () => {
    const user = userEvent.setup();
    const failed: InstallSessionView = {
      ...base,
      status: 'completed',
      hosts: [
        {
          ...base.hosts[0]!,
          status: 'installed',
          cleanup: 'failed',
          error: 'run on the server: sudo userdel -r pcp-install',
        },
      ],
    };
    const api = fakeApi({ get: vi.fn().mockResolvedValue(failed) });
    render(<AssistedInstallDialog environments={environments} api={api} pollMs={0} />);
    await user.click(screen.getByRole('button', { name: 'Assisted install' }));
    await user.type(screen.getByLabelText('Servers'), '198.51.100.10');
    await user.click(screen.getByRole('button', { name: 'Start session' }));
    await user.click(await screen.findByRole('button', { name: 'Key added, connect' }));
    expect(await screen.findByText(/sudo userdel -r pcp-install/)).toBeInTheDocument();
    await act(async () => {
      await user.click(screen.getByRole('button', { name: 'End session' }));
    });
    expect(api.abort).toHaveBeenCalledWith('s1');
  });
});
