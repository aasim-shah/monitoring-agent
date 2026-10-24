// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GuidedSetup, type Guide } from './guided-setup';

afterEach(cleanup);

const guide: Guide = {
  summary: 'Request rates from the OpenTelemetry Node.js SDK.',
  steps: [
    { text: 'Install the SDK.', command: 'npm install @opentelemetry/auto-instrumentations-node' },
    { text: 'Set the environment.', command: 'export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318' },
    { text: 'Restart the app.' },
  ],
  proof: 'http_server_.*',
  proofLabel: 'HTTP server request duration from the SDK',
  troubleshooting: ['The app runs on the same host as the agent.', 'NODE_OPTIONS reaches the app process.'],
};

describe('Level 2 guided setup (M10.5, UC-11-04)', () => {
  it('shows each step with its exact command and a copy button, and says the platform runs nothing', async () => {
    const user = userEvent.setup();
    render(
      <GuidedSetup
        name="Node.js"
        guide={guide}
        verify={vi.fn().mockResolvedValue({ status: 'not_found', series: 0 })}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Deep metrics for Node.js' }));
    const steps = screen.getByRole('list', { name: 'Setup steps' });
    expect(within(steps).getAllByRole('listitem')).toHaveLength(3);
    expect(within(steps).getByText(/npm install @opentelemetry/).tagName).toBe('CODE');
    expect(within(steps).getAllByRole('button', { name: /Copy command/ })).toHaveLength(2);
    expect(screen.getByText(/You make these changes; the platform never runs them/)).toBeInTheDocument();
  });

  it('turns green when the proof metric arrives (TC-11-06)', async () => {
    const user = userEvent.setup();
    render(
      <GuidedSetup
        name="Node.js"
        guide={guide}
        verify={vi.fn().mockResolvedValue({ status: 'active', series: 3 })}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Deep metrics for Node.js' }));
    expect(await screen.findByText('Deep metrics active')).toBeInTheDocument();
  });

  it('after 15 minutes without the metric, shows the troubleshooting checklist', async () => {
    const user = userEvent.setup();
    const now = vi.fn(() => Date.parse('2026-10-25T10:00:00Z'));
    const { rerender } = render(
      <GuidedSetup
        name="Node.js"
        guide={guide}
        verify={vi.fn().mockResolvedValue({ status: 'not_found', series: 0 })}
        now={now}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Deep metrics for Node.js' }));
    expect(await screen.findByText(/Waiting for HTTP server request duration/)).toBeInTheDocument();
    now.mockReturnValue(Date.parse('2026-10-25T10:16:00Z'));
    rerender(
      <GuidedSetup
        name="Node.js"
        guide={guide}
        verify={vi.fn().mockResolvedValue({ status: 'not_found', series: 0 })}
        now={now}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Check now' }));
    const list = await screen.findByRole('list', { name: 'Troubleshooting' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
  });
});
