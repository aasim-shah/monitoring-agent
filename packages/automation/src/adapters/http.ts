/** What the adapters need from an HTTP client (the connector SDK's SSRF-guarded client fits). */
export interface HttpLike {
  request(
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<{ status: number; text(): string; json<T = unknown>(): T }>;
}

export type AdapterResult =
  | { ok: true; result: Record<string, unknown>; verification: Record<string, unknown> }
  | { ok: false; error: string; verification?: Record<string, unknown> };
