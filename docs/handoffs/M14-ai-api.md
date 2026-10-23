# Handoff — M14 AI API (tools, conversations, SSE, settings)

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-23 |
| **Branch** | `feat/m14-ai` |
| **Plan** | M14 plan Task 4 |
| **Workbooks** | WB-14 §4, §7, TC-14-01, TC-14-06 |

## Delivered (`apps/api/src/modules/ai`)

- **Tools** (`tools.ts`):
  - **Scope:** every tool is bound to the conversation's product (`deps.productId`); the model never chooses a product.
  - **Out-of-scope IDs:** a 404 from the services becomes `ToolNotFound`.
  - **Data handling:** host metrics reach the model only as summaries (min, avg, max, latest), never raw series. Log tools return counts, never log text.

  | Tool | Returns |
  |---|---|
  | `listProducts` | the member's products |
  | `listAssets` | up to 200 assets |
  | `getAssetDetails` | one asset; another product's asset counts as not found |
  | `getDependencies` | an asset's relationships |
  | `getPotentialImpact` | the blast radius at depth 4 |
  | `getInfrastructureMetrics` | CPU, memory, and disk per host as min, avg, max over 1h, 24h, or 7d (`*_over_time` subqueries through the tenant-scoped query service), plus the latest value |
  | `getApplicationErrors` | error and warn log line counts per host and service |
  | `getConnectionHealth` | connection status and the latest health check |
  | `getDatabaseHealth` | connections, maximum connections, and replication lag from the latest health detail |
  | `getIncidents` | active or all incidents, up to 20 |
  | `comparePeriods` | the average of cpu, memory, or disk in the current window against the previous one, with the change computed deterministically |
  | `getWebsiteAvailability`, `getAnalyticsReport`, `getAdPerformance`, `getDeployments`, `getApplicationMetrics` | the gap "source not connected" or "not instrumented" |

- **Provider** (`provider.factory.ts`):
  - **Configuration:** `AI_PROVIDER`/`AI_MODEL` are the primary and `AI_FALLBACK_PROVIDER`/`AI_FALLBACK_MODEL` the fallback (defaults: Gemini `gemini-2.5-flash`, Groq `openai/gpt-oss-120b`). The keys are `GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, and `OPENAI_API_KEY`.
  - **No provider configured:** the AI routes answer `409 ai_unavailable`.
  - **`PCP_AI_FAKE=1`:** a deterministic scripted provider that chooses tools from the question and cites every evidence ID.
- **Routes:**
  - **Conversations:** `POST/GET /api/v1/products/:id/ai/conversations` (`ai.use`). The list shows only the caller's own conversations from the last 90 days.
  - **One conversation:** `GET /api/v1/ai/conversations/:id`.
  - **Asking:** `POST /api/v1/ai/conversations/:id/messages` streams SSE:
    - `started`
    - `tool`, sent when each tool starts and again when it ends
    - `answer`, with `{text, evidence, missing, confidence, validation, problems}`
    - `done`
  - **Settings:** `GET/PATCH /api/v1/organizations/:orgId/settings/ai`. Reading needs `org.view`; changing needs `org.settings.manage` and is audited (`ai.settings_update`).
- **Persistence:**
  - the user and assistant messages; the assistant message carries evidence, missing evidence, confidence, and validation
  - the run (status, provider, tool calls) and every tool execution
  - an audit row `ai.tool_denied` for each denied call
  - the last 10 messages are sent back as history
- **Guard resource `ai_conversation`:** resolved with `pcp_resolve_ai_conversation`, so product scoping applies.
- **Other:** `AssetsModule` now exports `AssetsService`, and `TelemetryQueryService.instant` takes an optional time.
- **OpenAPI:** typed `AiSettings`, `AiMessage`, and the conversation routes. The API client was regenerated.

## Tests

`ai.int.test.ts` (4) covers:
- the SSE event order and a verified, cited answer with the missing deployments source, with the conversation, run, and list stored
- TC-14-01: another tenant's asset ID is denied, never shows up in the stream, and is audited
- Review Focus #4: a product-scoped analyst sees only their product, and the hidden product gets 404
- TC-14-06: a viewer gets 404, and turning AI off gives 409 `ai_disabled` while incidents still answer

The assets and telemetry suites stay green (28).
