// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InstallCommand } from './install-command';

afterEach(cleanup);

describe('InstallCommand', () => {
  it('copies the exact command and confirms', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    const command =
      'curl -fsSL https://app/install.sh | sudo bash -s -- --token pcp_enr_x --control-url https://agent';
    render(<InstallCommand command={command} />);
    expect(screen.getByText(/Shown once/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copy command' }));
    expect(writeText).toHaveBeenCalledWith(command);
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });
});
