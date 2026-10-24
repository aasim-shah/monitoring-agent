// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GOOGLE_SCOPES } from '@/lib/google';
import { GoogleAccess } from './google-access';
import { GoogleConnectDialog } from './google-connect';

afterEach(cleanup);

const partial = GOOGLE_SCOPES.filter((s) => !s.endsWith('/adwords') && !s.endsWith('/bigquery.readonly'));

describe('Google connection access (WB-08 UC-08-02, BR-08-03, BR-08-07)', () => {
  it('shows who granted access and each service; missing access offers "Grant access"', async () => {
    const user = userEvent.setup();
    const onGrant = vi.fn().mockResolvedValue(undefined);
    render(
      <GoogleAccess accountEmail="ops@acme.example" grantedScopes={partial} canConfigure onGrant={onGrant} />,
    );
    expect(screen.getByText(/Connected as ops@acme.example/)).toBeInTheDocument();
    const grid = screen.getByRole('table', { name: 'Google services' });
    const row = (name: string) => within(grid).getByRole('row', { name: new RegExp(name) });
    expect(row('GA4')).toHaveTextContent('Available');
    expect(row('Google Ads')).toHaveTextContent('Access not granted');
    expect(row('BigQuery exports')).toHaveTextContent('Access not granted');
    await user.click(screen.getByRole('button', { name: 'Grant access' }));
    expect(onGrant).toHaveBeenCalled();
  });

  it('with every scope granted, Ads waits for platform approval and nothing is left to grant', () => {
    render(<GoogleAccess accountEmail={null} grantedScopes={GOOGLE_SCOPES} canConfigure onGrant={vi.fn()} />);
    expect(
      within(screen.getByRole('row', { name: /Google Ads/ })).getByText('Pending platform approval'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Grant access' })).toBeNull();
  });
});

describe('Connect with Google (WB-08 UC-08-01)', () => {
  it('explains every scope in one line before sending the member to Google', async () => {
    const user = userEvent.setup();
    const onConnect = vi.fn().mockResolvedValue(undefined);
    render(<GoogleConnectDialog onConnect={onConnect} />);
    await user.click(screen.getByRole('button', { name: 'Connect Google' }));
    const scopes = screen.getByRole('list', { name: 'Google access requested' });
    expect(within(scopes).getAllByRole('listitem')).toHaveLength(11);
    expect(scopes).toHaveTextContent('Search Console: clicks, impressions, positions');
    expect(screen.getByText(/shared operations account/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Continue to Google' }));
    expect(onConnect).toHaveBeenCalled();
  });
});
