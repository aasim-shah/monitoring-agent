export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Set when the model sent arguments that are not valid JSON; the loop reports it back. */
  error?: string;
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema of the arguments. */
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools: ToolSchema[];
  signal?: AbortSignal;
}

export interface ChatResponse {
  text?: string;
  toolCalls: ToolCall[];
  /** Which provider answered (set by `chain`). */
  provider?: string;
}

export interface ChatProvider {
  id: string;
  model: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
}

/** A provider failure; retryable failures (429, 5xx, timeout, network) move on to the fallback. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
