import { describe, expect, it } from 'vitest';
import { ApiError, unwrap } from './index.js';

const response = (status: number) => new Response(null, { status });

describe('unwrap', () => {
  it('returns data on success', () => {
    expect(unwrap({ data: { id: '1' }, response: response(200) })).toEqual({ id: '1' });
  });

  it('returns undefined for 204', () => {
    expect(unwrap({ data: undefined, response: response(204) })).toBeUndefined();
  });

  it('throws ApiError with the API error body', () => {
    try {
      unwrap({
        error: { code: 'invalid_credentials', message: 'Email or password is incorrect', requestId: 'req-1' },
        response: response(401),
      });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect(e).toMatchObject({
        status: 401,
        code: 'invalid_credentials',
        message: 'Email or password is incorrect',
        requestId: 'req-1',
      });
    }
  });

  it('falls back to a generic code for non-JSON errors', () => {
    expect(() => unwrap({ error: 'Bad Gateway', response: response(502) })).toThrow(
      expect.objectContaining({ status: 502, code: 'error' }),
    );
  });
});
