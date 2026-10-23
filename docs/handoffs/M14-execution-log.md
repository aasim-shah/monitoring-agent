# Execution Log — M14 AI Assistant

| | |
|---|---|
| **Plan** | `docs/superpowers/plans/2026-10-23-m14-ai.md` |
| **Branch** | `feat/m14-ai` (stacked on `feat/m12-alerts`) |
| **Executed** | 2026-10-23, inline, test-first. Final review was a self-review (no subagent). |
| **Deployed** | `https://monitor.aasimshah.com` (migration 0008; api and web; Gemini `gemini-2.5-flash` primary, Groq `openai/gpt-oss-120b` fallback; other VPS sites unchanged) |

## Ledger

```text
# SDD ledger — plan: docs/superpowers/plans/2026-10-23-m14-ai.md
Spec: spec §4.9, §12, §18.1–18.2; master plan M14.1–M14.4, D6, D19, §3 AI limits; WB-14; branch feat/m14-ai stacked on feat/m12-alerts.
Pre-flight: T1 tables consumed by T4 persistence — consistent; T2 ChatProvider consumed by T3 loop and T4 factory — consistent; T3 defineTool/runInvestigation consumed by T4 tools/SSE — consistent; T4 SSE events consumed by T5 UI — consistent.
Ruling: providers are Gemini (primary) and Groq (fallback) through OpenAI-compatible endpoints; Anthropic adapter (D19 default) deferred — user chose Gemini/Groq, no Anthropic key — cost if wrong: one adapter file.
Ruling: plan executed without separate review — user asked to continue — cost if wrong: re-plan.
Task 1: complete (commits 2ab3231..fd47d69, tests: database alerting+rls+schema-drift → 95/95)
Task 2: complete (commits fd47d69..79a6a4b, tests: ai-orchestrator providers → 6/6 incl. recorded Gemini+Groq)
Task 3: Ruling: validator allows integers ≤ 10 without evidence (counts read from lists) — otherwise every 'two hosts' fails — cost if wrong: a fabricated small integer passes.
Task 3: complete (commits 79a6a4b..1198674, tests: ai-orchestrator → 15/15)
Task 4: Ruling: conversation list shows only the caller's own conversations (not all product members') — conversations may contain a member's private questions — cost if wrong: add a shared view later.
Task 4: complete (commits 1198674..b8eb84a, tests: api ai 4/4 + assets/telemetry 24; openapi 4/4; api-client)
Task 5: complete (commits b8eb84a..1505492, tests: apps/web vitest → 141/141 incl. ai 6, sse 4, nav, incidents)
Task 6: real-provider check (Gemini + Groq, scratch test, not committed): both call tools with the schemas; Gemini verified; Groq falsely unverified because of non-breaking hyphens in dates; Gemini named the wrong timezone — fixed in 0bb5fad (validator normalization, prompt states UTC offset and the "yesterday" window), tests RED→GREEN.
Final review: self-review (no subagent without the user's request)
Final: fixed conversations readable/continuable by other ai.use members via ID — owner-only lookup — ai.int.test "keeps a member's conversation private" RED→GREEN, api ai 5/5
Final: fixed unexpected failure after SSE opened left stream and run open — try/catch closes with error event, run failed; chat shows error event — ai.test "shows an error event" RED→GREEN, web ai 7/7
Final: minor (deferred): a closed browser tab does not cancel the run (finishes and stores the answer; costs provider tokens)
Final: minor (deferred): GET /api/v1/ai/runs/:id (WB-14 §7) not implemented; run data is stored and visible through the message evidence
```

## Results

- **Exit gate (Playwright, scripted provider):** in the e2e stack, the scripted provider answers without calling a real model.
  - "Why was FireMaps slow yesterday?" gives a verified answer with tool steps shown and `[E1]` chips. The evidence panel links to the incident, and missing evidence lists "Deployments: source not connected".
  - Another organization's asset gives "Could not check asset details", its name never appears, and an `ai.tool_denied` audit row is written.
  - "Ask AI" appears on incidents and disappears when AI is turned off.
- **Real providers (scratch run):** Gemini and Groq both call the tools with the generated schemas.
  - Groq's typographic hyphens and Gemini's wrong timezone label were fixed in the validator and the prompt.
- **Found by the gate:** the first question in a new chat never showed its answer, because creating the conversation remounted the chat and aborted the stream. Fixed.
- **Found by self-review:**
  - Conversations were readable by other `ai.use` members who had the ID; they are now private to their author.
  - An unexpected failure left the stream and the run open; it now ends both with an error.
- **Pipeline:** turbo 86/86, `test:repo` 56, spectral, Go, smoke, e2e 6/6, and agent-e2e 5/5.
- **Production check:** a test organization with one seeded incident asked "What is wrong right now?". Gemini called `getIncidents` and `getInfrastructureMetrics` and answered with confidence high and the validation verified, citing `[E1]` and `[E2]`. It listed "Host metrics: no agent has reported for this product" as missing.

## Deferred minors

- Closing the browser tab does not cancel a run; it finishes and stores the answer, which costs provider tokens.
- `GET /api/v1/ai/runs/:id` is not implemented; run data is stored and visible through the message evidence.
- The Anthropic adapter (D19's default) waits for a key.
- `proposeAction` waits for M16; scheduled investigations wait for M15.
- Website, analytics, ads, deployment, and application-metric tools report "source not connected" until M7 and M13.

## How to resume

- **Using it:** open Product → AI Assistant and ask a question, or use "Ask AI" on an incident. Admins can turn the assistant off under Settings → AI assistant.
- **Configuration:**
  - `AI_PROVIDER` and `AI_MODEL`, plus `AI_FALLBACK_PROVIDER` and `AI_FALLBACK_MODEL`, with `GEMINI_API_KEY` and `GROQ_API_KEY`, in `/opt/pcp/.env`.
  - The keys were pasted in chat earlier, so rotate them in the provider consoles and update the env file.
- **Next:** M13 (Google: GA4, Firebase, Search Console; the OAuth client is ready), M15 reports, M16 approvals. M7 is waiting for the GitHub OAuth app.
