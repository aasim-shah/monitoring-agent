/** Error returned by the Control API: `{ code, message, requestId }` with the HTTP status. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static from(status: number, body: unknown): ApiError {
    if (body && typeof body === 'object' && 'code' in body) {
      const b = body as { code: unknown; message?: unknown; requestId?: unknown };
      return new ApiError(
        status,
        String(b.code),
        typeof b.message === 'string' ? b.message : 'Request failed',
        typeof b.requestId === 'string' ? b.requestId : undefined,
      );
    }
    return new ApiError(
      status,
      'error',
      'The server returned an unexpected response. Please try again later.',
    );
  }
}

/** Returns `data` from an openapi-fetch result, or throws ApiError. */
export function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (result.error !== undefined || !result.response.ok)
    throw ApiError.from(result.response.status, result.error);
  return result.data as T;
}
