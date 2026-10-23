import { can, type TenantContext } from '@pcp/shared-contracts';
import { ToolNotFound, type Tool } from './tools.js';

export const TOOL_TIMEOUT_MS = 15_000;
export const TOOL_MAX_BYTES = 64 * 1024;

export type ToolStatus = 'ok' | 'denied' | 'error' | 'truncated';

export interface Evidence {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  status: ToolStatus;
  /** Exactly what the model saw (JSON, at most 64 KB). */
  json: string;
  gaps: string[];
  sources: Array<{ label: string; href?: string }>;
  durationMs: number;
  bytes: number;
}

/**
 * Runs one tool call (BR-14-02/07): Zod-validated input, `can()` with the caller's context,
 * 15 s timeout, 64 KB result. Every failure becomes a result the model sees, never an exception.
 */
export async function executeTool(
  tool: Tool | undefined,
  name: string,
  ctx: TenantContext,
  rawInput: Record<string, unknown>,
  deps: unknown,
  evidenceId: string,
  opts: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<Evidence> {
  const started = Date.now();
  const done = (status: ToolStatus, data: unknown, gaps: string[], sources: Evidence['sources'] = []) => {
    const maxBytes = opts.maxBytes ?? TOOL_MAX_BYTES;
    let json = JSON.stringify({ evidenceId, status, data, gaps });
    if (Buffer.byteLength(json) > maxBytes) {
      status = 'truncated';
      gaps = [...gaps, `${name}: result truncated to 64 KB; ask for a narrower range`];
      // Escaping can grow the text, so shrink until the whole message fits.
      const full = JSON.stringify(data);
      let keep = maxBytes - 512;
      do {
        json = JSON.stringify({ evidenceId, status, data: { truncated: full.slice(0, keep) }, gaps });
        keep = Math.floor(keep * 0.8);
      } while (Buffer.byteLength(json) > maxBytes && keep > 0);
    }
    return {
      id: evidenceId,
      tool: name,
      input: rawInput,
      status,
      json,
      gaps,
      sources,
      durationMs: Date.now() - started,
      bytes: Buffer.byteLength(json),
    };
  };
  if (!tool) return done('error', null, [`${name}: no such tool`]);
  const parsed = tool.input.safeParse(rawInput);
  if (!parsed.success)
    return done('error', null, [`${name}: invalid input (${parsed.error.issues[0]?.message ?? 'invalid'})`]);
  if (!can(ctx, tool.permission)) return done('denied', null, [`${name}: not permitted for your role`]);
  try {
    const out = await Promise.race([
      tool.run(ctx, parsed.data, deps),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timed out')), opts.timeoutMs ?? TOOL_TIMEOUT_MS).unref(),
      ),
    ]);
    return done('ok', out.data, out.gaps ?? [], out.sources ?? []);
  } catch (err) {
    if (err instanceof ToolNotFound) return done('denied', null, [`${name}: not found`]);
    return done('error', null, [`${name}: ${err instanceof Error ? err.message : 'failed'}`]);
  }
}
