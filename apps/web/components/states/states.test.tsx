// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@pcp/api-client';
import { Disconnected } from './disconnected';
import { Empty } from './empty';
import { ErrorState } from './error-state';
import { Loading } from './loading';
import { NotFoundState } from './not-found-state';

describe('state components', () => {
  it('Loading announces progress', () => {
    render(<Loading label="Loading products" />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading products');
  });

  it('Empty shows a title and an optional action', () => {
    render(<Empty title="No products yet" action={<button>Create product</button>} />);
    expect(screen.getByText('No products yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create product' })).toBeInTheDocument();
  });

  it('ErrorState shows the API message and retries', async () => {
    const onRetry = vi.fn();
    render(
      <ErrorState error={new ApiError(500, 'internal_error', 'Internal error', 'req-9')} onRetry={onRetry} />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Internal error');
    expect(screen.getByRole('alert')).toHaveTextContent('req-9');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('Disconnected explains the API is unreachable', () => {
    render(<Disconnected />);
    expect(screen.getByRole('alert')).toHaveTextContent(/cannot reach/i);
  });

  it('NotFoundState never reveals whether a resource exists', () => {
    render(<NotFoundState />);
    expect(screen.getByRole('heading')).toHaveTextContent('Not found');
    expect(screen.getByText(/does not exist or you do not have access/i)).toBeInTheDocument();
  });
});
