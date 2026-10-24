// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagedExporterButton } from './managed-exporter';

afterEach(cleanup);

describe('ManagedExporterButton (M18.3, Level 1)', () => {
  it('proposes the install and says it waits for approval', async () => {
    const user = userEvent.setup();
    const propose = vi
      .fn()
      .mockResolvedValue({ status: 'pending_approval', reason: 'Approval required by policy' });
    render(<ManagedExporterButton exporter="redis_exporter" propose={propose} />);
    await user.click(screen.getByRole('button', { name: 'Install redis_exporter (Level 1)' }));
    expect(propose).toHaveBeenCalledWith('redis_exporter');
    expect(await screen.findByText(/waits for approval/)).toBeInTheDocument();
  });

  it('shows why a policy refused it', async () => {
    const user = userEvent.setup();
    const propose = vi.fn().mockResolvedValue({
      status: 'rejected_policy',
      reason: 'No enabled policy for host.install_exporter in production',
    });
    render(<ManagedExporterButton exporter="kafka_exporter" propose={propose} />);
    await user.click(screen.getByRole('button', { name: 'Install kafka_exporter (Level 1)' }));
    expect(await screen.findByText(/No enabled policy for host.install_exporter/)).toBeInTheDocument();
  });
});
