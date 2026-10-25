// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FleetTable, type FleetAgent } from './fleet-table';

afterEach(cleanup);

const agent = (over: Partial<FleetAgent>): FleetAgent => ({
  id: 'a1',
  hostname: 'api-1',
  os: 'ubuntu-24.04',
  arch: 'amd64',
  agentVersion: '1.0.0',
  environmentName: 'production',
  status: 'active',
  stale: false,
  lastHeartbeatAt: '2026-10-22T11:59:30Z',
  duplicateMachineId: false,
  ...over,
});

describe('FleetTable', () => {
  it('links each host to its detail page and shows status and last seen', () => {
    render(
      <FleetTable
        agents={[agent({})]}
        basePath="/orgs/o/products/p/agents"
        now={new Date('2026-10-22T12:00:00Z')}
      />,
    );
    expect(screen.getByRole('link', { name: 'api-1' }).getAttribute('href')).toBe(
      '/orgs/o/products/p/agents/a1',
    );
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByTitle('30 s ago')).toHaveAttribute('datetime', '2026-10-22T11:59:30Z');
    expect(screen.getByRole('link', { name: 'Inspect agent ↗' })).toHaveAttribute(
      'href',
      '/orgs/o/products/p/agents/a1',
    );
  });

  it('warns about duplicate machine IDs (cloned images)', () => {
    render(<FleetTable agents={[agent({ duplicateMachineId: true })]} basePath="/x" />);
    expect(screen.getByTitle(/Another server reports the same machine ID/)).toBeInTheDocument();
  });
});
