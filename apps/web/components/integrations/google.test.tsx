// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '@pcp/api-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GOOGLE_SCOPES, GOOGLE_SCOPE_PURPOSES } from '@/lib/google';
import { GoogleAccess } from './google-access';
import { GoogleConnectDialog } from './google-connect';

afterEach(cleanup);

const partial = GOOGLE_SCOPES.filter((s) => !s.endsWith('/adwords') && !s.endsWith('/bigquery.readonly'));

describe('Google connection access (WB-08 UC-08-02, BR-08-03, BR-08-07)', () => {
  it('shows who granted access and each service; missing access offers "Grant access"', async () => {
    const user = userEvent.setup();
    const onGrant = vi.fn().mockResolvedValue(undefined);
    render(
      <GoogleAccess
        accountEmail="ops@acme.example"
        grantedScopes={partial}
        canConfigure
        onGrant={onGrant}
        onUploadKey={vi.fn()}
        onCheckKey={vi.fn()}
      />,
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
    render(
      <GoogleAccess
        accountEmail={null}
        grantedScopes={GOOGLE_SCOPES}
        canConfigure
        onGrant={vi.fn()}
        onUploadKey={vi.fn()}
        onCheckKey={vi.fn()}
      />,
    );
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
    render(<GoogleConnectDialog onConnect={onConnect} onUploadKey={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Connect Google' }));
    const scopes = screen.getByRole('list', { name: 'Google access requested' });
    expect(within(scopes).getAllByRole('listitem')).toHaveLength(11);
    expect(scopes).toHaveTextContent('Search Console: clicks, impressions, positions');
    expect(screen.getByText(/shared operations account/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Continue to Google' }));
    expect(onConnect).toHaveBeenCalled();
  });
});

describe('Google service account keys (connect without Google sign-in)', () => {
  const SA = 'pcp-reader@acme-prod.iam.gserviceaccount.com';
  const keyFile = () => new File(['{"type":"service_account"}'], 'key.json', { type: 'application/json' });

  it('the connect dialog uploads a JSON key as the second way in', async () => {
    const user = userEvent.setup();
    const onUploadKey = vi.fn().mockResolvedValue(undefined);
    render(<GoogleConnectDialog onConnect={vi.fn()} onUploadKey={onUploadKey} />);
    await user.click(screen.getByRole('button', { name: 'Connect Google' }));
    const section = screen.getByRole('region', { name: 'Connect with a service account key' });
    expect(section).toHaveTextContent(/no passkey/);
    await user.upload(within(section).getByLabelText('Service account JSON key'), keyFile());
    expect(onUploadKey).toHaveBeenCalledWith('{"type":"service_account"}');
  });

  it('shows a refused key as an error', async () => {
    const user = userEvent.setup();
    const onUploadKey = vi
      .fn()
      .mockRejectedValue(
        new ApiError(400, 'invalid_service_account_key', 'This is not a service account key'),
      );
    render(<GoogleConnectDialog onConnect={vi.fn()} onUploadKey={onUploadKey} />);
    await user.click(screen.getByRole('button', { name: 'Connect Google' }));
    await user.upload(screen.getByLabelText('Service account JSON key'), keyFile());
    expect(await screen.findByText('This is not a service account key')).toBeInTheDocument();
  });

  it('a service account connection lists where to add its email and checks access again; Ads needs Google', async () => {
    const user = userEvent.setup();
    const onCheckKey = vi.fn().mockResolvedValue(undefined);
    const onGrant = vi.fn();
    const ga4 = GOOGLE_SCOPE_PURPOSES.map(([s]) => s).filter((s) => s.endsWith('/analytics.readonly'));
    render(
      <GoogleAccess
        accountEmail={SA}
        grantedScopes={ga4}
        canConfigure
        onGrant={onGrant}
        onUploadKey={vi.fn()}
        onCheckKey={onCheckKey}
      />,
    );
    expect(screen.getByText(`Connected with service account ${SA}`)).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Where to add the service account' })).toHaveTextContent(
      'Search Console',
    );
    const row = (name: string) => screen.getByRole('row', { name: new RegExp(name) });
    expect(row('GA4')).toHaveTextContent('Available');
    expect(row('Search Console')).toHaveTextContent('Access not granted');
    expect(row('Google Ads')).toHaveTextContent('Needs Continue with Google');
    expect(screen.queryByRole('button', { name: 'Grant access' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Check access again' }));
    expect(onCheckKey).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Replace JSON key' })).toBeInTheDocument();
  });

  it('an OAuth connection can switch to a key', () => {
    render(
      <GoogleAccess
        accountEmail="ops@acme.example"
        grantedScopes={GOOGLE_SCOPES}
        canConfigure
        onGrant={vi.fn()}
        onUploadKey={vi.fn()}
        onCheckKey={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Use a service account key instead' })).toBeInTheDocument();
  });
});
