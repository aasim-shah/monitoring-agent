// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentStatusBadge } from './agent-status-badge';

afterEach(cleanup);

describe('AgentStatusBadge', () => {
  it('labels each status and adds Stale when heartbeats stopped', () => {
    render(<AgentStatusBadge status="degraded" stale />);
    expect(screen.getByText('Degraded')).toBeInTheDocument();
    expect(screen.getByText('Stale')).toBeInTheDocument();
  });

  it('shows Active without a stale marker', () => {
    render(<AgentStatusBadge status="active" stale={false} />);
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.queryByText('Stale')).toBeNull();
  });

  it('never marks a revoked agent stale', () => {
    render(<AgentStatusBadge status="revoked" stale />);
    expect(screen.getByText('Revoked')).toBeInTheDocument();
    expect(screen.queryByText('Stale')).toBeNull();
  });
});
