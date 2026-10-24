// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SsoButtons } from './sso-buttons';

afterEach(cleanup);

describe('SsoButtons (M19.4)', () => {
  it('shows the sign-in methods the deployment offers', async () => {
    render(
      <SsoButtons
        load={vi.fn().mockResolvedValue({
          google: true,
          oidc: { name: 'Acme SSO', startUrl: '/api/v1/auth/oidc/start' },
        })}
      />,
    );
    expect(await screen.findByRole('link', { name: 'Continue with Acme SSO' })).toHaveAttribute(
      'href',
      '/api/v1/auth/oidc/start',
    );
    expect(screen.getByRole('link', { name: 'Continue with Google' })).toHaveAttribute(
      'href',
      '/api/v1/auth/google/start',
    );
  });

  it('shows nothing when only passwords are configured or the call fails', async () => {
    const { container } = render(<SsoButtons load={vi.fn().mockRejectedValue(new Error('x'))} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent).toBe('');
  });
});
