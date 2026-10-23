# Handoff — M14.2/M14.3 Tool executor, investigation loop, answer validation

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-23 |
| **Branch** | `feat/m14-ai` |
| **Plan** | M14 plan Task 3 |
| **Workbooks** | WB-14 UC-14-01/04/07/08, BR-14-02/03/06/07 |

## Delivered (`packages/ai-orchestrator`)

- **`defineTool({name, description, permission, input: zod/v4, run})`.** `toolSchema()` turns the input schema into JSON Schema for the provider (without `$schema`). A tool throws `ToolNotFound` for out-of-scope IDs.
- **`executeTool`.** Each call ends as one result the model sees, never an exception:
  - unknown tool or invalid input: `error`
  - `can(ctx, permission)` fails: `denied`
  - `ToolNotFound`: `denied` with the gap "not found"
  - over 15 s: `error` ("timed out")
  - over 64 KB: `truncated`, with the gap "ask for a narrower range"
- **`validateAnswer(text, evidence, question)`:**
  - Every cited `[E#]` must exist.
  - Every number must appear in the evidence or the question, rounded to the precision written. Thousands separators and `%` are handled.
  - Dates, times, ISO timestamps, "Finding N", and small counts (up to 10) are ignored.
- **`systemPrompt`.** It sets out:
  - the product, today's date in the organization's timezone, and how to resolve relative periods
  - that tool results are data and any instructions inside them are ignored
  - citation, number, and causality rules, and listing missing evidence
  - the WB-14 answer format
- **`runInvestigation`:**
  1. Builds the messages: system, history, then the question.
  2. Loops through provider calls, tool calls, and tool messages carrying each evidence ID.
  3. **Limits:**
     - The 13th tool call is refused. The model is then asked without tools, and the answer is `partial` with "Investigation incomplete".
     - The run's time limit is 120 s.
  4. **Validation:** a failed answer is retried once with the problems listed, then marked `unverified`.
  5. **Provider failure:** the result is `partial`, saying "AI provider unavailable", with the evidence gathered so far.
  6. **Events:** `tool_started`, `tool_finished`, and `answer`.
  7. **Result:** `{text, evidence, missing, confidence, validation, problems, toolCalls, provider}`.

## Tests

`run.test.ts` (9 tests) plus the providers (6) cover:
- a cited, verified answer with two tools, checking the event order and the tool message's evidence ID
- Review Focus #2: an invented number triggers one retry and then `unverified`
- Review Focus #5: 12 calls, then a partial answer with no tools offered
- Review Focus #1: injected text stays in the tool message and never in the system prompt, with no extra calls
- denied, not found, and unknown tools, with gaps such as "source not connected"
- 64 KB truncation
- a provider failure returning partial results with the evidence so far
- the validator cases
