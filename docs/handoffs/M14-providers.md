# Handoff — M14.1 LLM provider layer

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-23 |
| **Branch** | `feat/m14-ai` |
| **Plan** | M14 plan Task 2 |
| **Workbooks** | WB-14 UC-14-06, TC-14-08 |

## Delivered (`packages/ai-orchestrator/src/providers`)

- **`openAiCompatible({ id, baseUrl, apiKey, model, timeoutMs })`** calls chat completions with tool calling.
  - It maps assistant tool calls and tool results to the wire format, and maps `tool_calls` back.
  - Arguments that are not valid JSON become a tool call with `error`, which the loop reports back to the model.
  - **Errors:** 429, 5xx, timeouts, and network errors are retryable; 400 and 401 are not. The API key is scrubbed from every error message.
  - **`PROVIDER_BASE_URLS`:** Gemini (`…/v1beta/openai`), Groq, OpenRouter, and OpenAI.
- **`chain([primary, fallback])`** moves to the next provider only on retryable failures. It reports which provider answered. When every provider fails, it throws "AI provider unavailable".
- **`scripted(id, steps)`** replays recorded steps, for tests and the e2e stack (`PCP_AI_FAKE=1`).
- **Real fixtures:** one tool-calling response each was recorded from Gemini `gemini-2.5-flash` and Groq `openai/gpt-oss-120b`, with ids and usage stripped and no keys. Both models called the tool with `{host:"vps-1", range:"1h"}`.

## Tests

`providers.test.ts` (6) covers:
- the recorded Gemini and Groq tool calls through a local server, checking the request shape (tools, `tool_choice`, assistant tool calls, tool messages, bearer header)
- final text
- malformed arguments
- the retryable classification for 429, 503, 400, and 401
- a timeout
- the key never appearing in errors
- the chain falling back on 429, not falling back on 400, and failing when all providers fail
