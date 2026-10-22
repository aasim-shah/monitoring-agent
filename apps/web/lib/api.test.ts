import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@pcp/api-client';
import { handleApiError } from './api';

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
