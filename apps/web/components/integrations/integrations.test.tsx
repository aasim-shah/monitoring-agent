// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { INTEGRATIONS } from '@/lib/integrations';
import { ConnectDialog } from './connect-dialog';
import { ConnectionDetail, type ConnectionDetailData } from './connection-detail';

afterEach(cleanup);

const cloudflareFields = [
  { name: 'apiToken', label: 'API token', secret: true },
  { name: 'webhookSecret', label: 'Notification webhook secret', secret: true, required: false },
];

describe('ConnectDialog (WB-06 UC-06-02)', () => {
  it('lists the Cloudflare token permissions and refuses an empty token', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <ConnectDialog
        spec={INTEGRATIONS.cloudflare}
        credentialFields={cloudflareFields}
        onSubmit={onSubmit}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Connect Cloudflare' }));
    const permissions = screen.getByRole('list', { name: 'Token permissions' });
    expect(within(permissions).getByText('Zone: Zone: Read')).toBeInTheDocument();
    expect(within(permissions).getByText('Zone: DNS: Read')).toBeInTheDocument();
    expect(screen.getByText(/Runs in the cloud/)).toBeInTheDocument();
    expect(screen.getByText(/Cache purge, after approval/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save and validate' }));
    expect(screen.getByText('API token is required')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
    await user.click(screen.getByLabelText('API token'));
    await user.paste('cf-token-1');
    await user.click(screen.getByRole('button', { name: 'Save and validate' }));
    expect(onSubmit).toHaveBeenCalledWith({
      provider: 'cloudflare',
      displayName: 'Cloudflare',
      config: {},
      credentials: { apiToken: 'cf-token-1' },
    });
  });

  it('collects the GitHub owner and an optional repository list', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <ConnectDialog
        spec={INTEGRATIONS.github}
        credentialFields={[{ name: 'token', label: 'Fine-grained personal access token', secret: true }]}
        onSubmit={onSubmit}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Connect GitHub' }));
    await user.click(screen.getByLabelText('Owner (user or organization)'));
    await user.paste('acme');
    await user.click(screen.getByLabelText('Repositories (optional, comma-separated)'));
    await user.paste('shop, api');
    await user.click(screen.getByLabelText('Fine-grained personal access token'));
    await user.paste('github_pat_1');
    await user.click(screen.getByRole('button', { name: 'Save and validate' }));
    expect(onSubmit).toHaveBeenCalledWith({
      provider: 'github',
      displayName: 'GitHub acme',
      config: { owner: 'acme', repositories: ['shop', 'api'] },
      credentials: { token: 'github_pat_1' },
    });
  });
});

const detail = (over: Partial<ConnectionDetailData> = {}): ConnectionDetailData => ({
  connection: {
    id: 'c1',
    provider: 'cloudflare',
    displayName: 'Cloudflare',
    status: 'connected',
    statusReason: null,
    scopes: [
      { externalId: 'z-other', resourceType: 'cloudflare_zone', name: 'other.example', productId: 'p2' },
    ],
  },
  productId: 'p1',
  webhookUrl: 'https://monitor.example.com/webhooks/cloudflare/c1',
  inventory: [
    { externalId: 'z1', resourceType: 'cloudflare_zone', name: 'shop.example', attributes: {} },
    { externalId: 'z2', resourceType: 'cloudflare_zone', name: 'blog.example', attributes: {} },
    { externalId: 'r1', resourceType: 'dns_record', name: 'www.shop.example', attributes: {} },
  ],
  deliveries: [
    {
      id: 'd1',
      deliveryId: 'del-1',
      eventType: 'dns_change',
      result: 'processed',
      detail: null,
      receivedAt: '2026-10-24T09:00:00Z',
    },
  ],
  events: [
    {
      id: 'e1',
      kind: 'dns_change',
      title: 'DNS record changed on shop.example',
      url: null,
      actor: null,
      externalId: 'x1',
      occurredAt: '2026-10-24T09:00:00Z',
    },
  ],
  runs: [],
  ...over,
});

describe('ConnectionDetail (WB-06 UC-06-05, UC-06-10)', () => {
  it('scopes the selected zones to this product and keeps other products’ scopes', async () => {
    const user = userEvent.setup();
    const onScope = vi.fn().mockResolvedValue(undefined);
    render(<ConnectionDetail data={detail()} canConfigure onScope={onScope} actions={{}} />);
    const inventory = screen.getByRole('region', { name: 'Discovered resources' });
    // DNS records follow their zone; only zones are scoped.
    expect(within(inventory).queryByLabelText('www.shop.example')).toBeNull();
    await user.click(within(inventory).getByLabelText('shop.example'));
    await user.click(within(inventory).getByRole('button', { name: 'Save scope' }));
    expect(onScope).toHaveBeenCalledWith([
      { externalId: 'z-other', resourceType: 'cloudflare_zone', name: 'other.example', productId: 'p2' },
      { externalId: 'z1', resourceType: 'cloudflare_zone', name: 'shop.example', productId: 'p1' },
    ]);
  });

  it('shows the webhook URL with a copy button and the delivery log rows', () => {
    render(<ConnectionDetail data={detail()} canConfigure onScope={vi.fn()} actions={{}} />);
    expect(screen.getByText('https://monitor.example.com/webhooks/cloudflare/c1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy webhook URL' })).toBeInTheDocument();
    const log = screen.getByRole('table', { name: 'Webhook deliveries' });
    expect(within(log).getByText('del-1')).toBeInTheDocument();
    expect(within(log).getByText('processed')).toBeInTheDocument();
    expect(screen.getByText('DNS record changed on shop.example')).toBeInTheDocument();
  });

  it('shows missing permissions and hides changes from members who cannot configure', () => {
    render(
      <ConnectionDetail
        data={detail({
          connection: {
            ...detail().connection,
            status: 'degraded',
            statusReason: 'permission_denied',
            missingPermissions: ['Zone: DNS: Read'],
          },
        })}
        canConfigure={false}
        onScope={vi.fn()}
        actions={{}}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('The token is missing: Zone: DNS: Read');
    expect(screen.queryByRole('button', { name: 'Save scope' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });
});
