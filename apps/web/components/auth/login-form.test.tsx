// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@pcp/api-client';
import { LoginForm } from './login-form';

async function fill(email: string, password: string) {
  await userEvent.type(screen.getByLabelText('Email'), email);
  await userEvent.type(screen.getByLabelText('Password'), password);
  await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('LoginForm', () => {
  it('validates before calling the API', async () => {
    const onSubmit = vi.fn();
    render(<LoginForm onSubmit={onSubmit} onSuccess={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Enter a valid email address')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('disables the button while signing in (Review Focus #4)', async () => {
    let resolve!: (v: { mfaRequired: boolean }) => void;
    const onSubmit = vi.fn(() => new Promise<{ mfaRequired: boolean }>((r) => (resolve = r)));
    render(<LoginForm onSubmit={onSubmit} onSuccess={vi.fn()} />);
    await fill('a@example.com', 'secret password');
    expect(screen.getByRole('button', { name: /Signing in/ })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: /Signing in/ }));
    expect(onSubmit).toHaveBeenCalledOnce();
    resolve({ mfaRequired: false });
  });

  it('shows the API message for invalid credentials', async () => {
    const onSubmit = vi
      .fn()
      .mockRejectedValue(new ApiError(401, 'invalid_credentials', 'Email or password is incorrect'));
    render(<LoginForm onSubmit={onSubmit} onSuccess={vi.fn()} />);
    await fill('a@example.com', 'wrong password');
    expect(await screen.findByRole('alert')).toHaveTextContent('Email or password is incorrect');
  });

  it('reports whether MFA is required', async () => {
    const onSuccess = vi.fn();
    render(<LoginForm onSubmit={vi.fn().mockResolvedValue({ mfaRequired: true })} onSuccess={onSuccess} />);
    await fill('a@example.com', 'secret password');
    await vi.waitFor(() => expect(onSuccess).toHaveBeenCalledWith(true));
  });
});
