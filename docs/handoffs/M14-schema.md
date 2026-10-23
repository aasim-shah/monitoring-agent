# Handoff — M14.1 AI schema (migration 0008)

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-23 |
| **Branch** | `feat/m14-ai` |
| **Plan** | M14 plan Task 1 |

## Delivered

| Table | Contents |
|---|---|
| `ai_settings` | One row per organization: `disabled`, and `provider` (null means the platform default) |
| `ai_conversations` | One per product: title, creator |
| `ai_messages` | Role, content, evidence, missing evidence, confidence, validation (`verified`, `unverified`, or `partial`), run |
| `ai_runs` | Status, provider, model, tool-call count, timing, error |
| `ai_tool_executions` | Tool, input, status (`ok`, `denied`, `error`, or `truncated`), evidence ID, duration, bytes |

- All five tables have forced RLS.
- `pcp_resolve_ai_conversation(id, user)` returns the conversation's organization and product, for members only. The tenant guard uses it.

## Tests

The RLS tests cover the new tables (95 database tests pass). The resolver test covers members versus non-members. The schema-drift check is clean.
