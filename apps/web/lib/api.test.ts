import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@pcp/api-client';
import { errorMessage, handleApiError } from './api';

const router = () => ({ replace: vi.fn() });

describe('handleApiError', () => {
  it('sends 401 to login with the current path as next', () => {
    const r = router();
    expect(handleApiError(new ApiError(401, 'unauthenticated', 'Sign in required'), r, '/orgs/x')).toBeNull();
    expect(r.replace).toHaveBeenCalledWith('/login?next=%2Forgs%2Fx');
  });

  it('sends mfa_required to /mfa', () => {
    const r = router();
    expect(handleApiError(new ApiError(403, 'mfa_required', 'MFA required'), r, '/orgs/x')).toBeNull();
    expect(r.replace).toHaveBeenCalledWith('/mfa');
  });

  it('returns other errors for the page to render', () => {
    const r = router();
    const err = new ApiError(404, 'not_found', 'Not found');
    expect(handleApiError(err, r, '/orgs/x')).toBe(err);
    expect(r.replace).not.toHaveBeenCalled();
  });
});

describe('errorMessage', () => {
  it('does not display HTML from a missing API route', () => {
    expect(errorMessage(new ApiError(404, 'error', '<!DOCTYPE html><html>Not found</html>'))).toBe(
      'Cannot reach the application API. Please try again later.',
    );
  });
  it('preserves structured API validation messages', () => {
    expect(errorMessage(new ApiError(400, 'validation_error', 'Enter a valid email'))).toBe(
      'Enter a valid email',
    );
  });
});
