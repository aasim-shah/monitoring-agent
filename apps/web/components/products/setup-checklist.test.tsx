// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSetupSteps } from '@/lib/setup-steps';
import { SetupChecklist } from './setup-checklist';

afterEach(cleanup);

describe('SetupChecklist', () => {
  it('shows progress and labels unbuilt steps "Coming soon"', () => {
    render(
      <SetupChecklist
        steps={buildSetupSteps({ orgId: 'o', productId: 'p', environments: 1, agents: 0, canManage: true })}
      />,
    );
    expect(screen.getByRole('heading', { name: /set up monitoring/i })).toBeTruthy();
    expect(screen.getByText('1 of 8 done')).toBeTruthy();
    expect(screen.getAllByText('Coming soon')).toHaveLength(4);
    expect(screen.getByRole('link', { name: 'Add server' }).getAttribute('href')).toBe(
      '/orgs/o/products/p/agents',
    );
    expect(screen.getByRole('link', { name: /invite your team/i }).getAttribute('href')).toBe(
      '/orgs/o/members',
    );
  });
});
