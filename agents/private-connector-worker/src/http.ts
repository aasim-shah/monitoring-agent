import { readFileSync } from 'node:fs';
import { Agent, fetch } from 'undici';

export interface TlsIdentity {
  certPem: string;
  keyPem: string;
}

/** A dispatcher with the worker's client certificate (mTLS through Caddy) and an optional extra root. */
export function dispatcher(opts: { caFile?: string; identity?: TlsIdentity }): Agent {
  return new Agent({
    connect: {
      ...(opts.caFile ? { ca: readFileSync(opts.caFile, 'utf8') } : {}),
      ...(opts.identity ? { cert: opts.identity.certPem, key: opts.identity.keyPem } : {}),
    },
    // Long-polls hold the request for up to 25 s.
    bodyTimeout: 60_000,
    headersTimeout: 60_000,
  });
}

export async function request(
  base: string,
  method: string,
  path: string,
  opts: { caFile?: string; identity?: TlsIdentity; body?: unknown; agent?: Agent } = {},
): Promise<{ status: number; json: unknown }> {
  const agent = opts.agent ?? dispatcher(opts);
  const res = await fetch(new URL(path, base), {
    method,
    dispatcher: agent,
    headers: opts.body === undefined ? {} : { 'content-type': 'application/json' },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  if (!opts.agent) await agent.close();
  let json: unknown = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text.slice(0, 300);
  }
  return { status: res.status, json };
}
