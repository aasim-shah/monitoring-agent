import { z } from 'zod/v4';
import type { Permission, TenantContext } from '@pcp/shared-contracts';

export interface ToolOutput {
  data: unknown;
  /** What this tool could not see (shown as missing evidence, never guessed). */
  gaps?: string[];
  /** Links to where a person can check the evidence. */
  sources?: Array<{ label: string; href?: string }>;
}

/** Thrown by a tool when an ID is outside the caller's scope: reported as `not_found` (TC-14-01). */
export class ToolNotFound extends Error {
  constructor(message = 'not found') {
    super(message);
    this.name = 'ToolNotFound';
  }
}

export interface Tool<I = unknown, D = unknown> {
  name: string;
  description: string;
  permission: Permission;
  input: z.ZodType<I>;
  run(ctx: TenantContext, input: I, deps: D): Promise<ToolOutput>;
}

/** A read-only tool the model may call; every call is authorized with the caller's context. */
export function defineTool<I, D = unknown>(tool: Tool<I, D>): Tool {
  return tool as unknown as Tool;
}

/** JSON Schema for the provider; `$schema` is dropped because some providers reject it. */
export function toolSchema(tool: Tool): {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
} {
  const { $schema: _, ...parameters } = z.toJSONSchema(tool.input, { io: 'input' }) as Record<
    string,
    unknown
  >;
  return { name: tool.name, description: tool.description, parameters };
}
