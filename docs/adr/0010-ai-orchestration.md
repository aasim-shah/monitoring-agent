# ADR 0010: AI orchestration and tool safety

Status: Proposed
Date: 2026-10-22
Deciders: tech lead, security owner

## Context

AI is an interface and reasoning layer over verified evidence, not the system of record (spec §1, §12). Prompt injection and sensitive-data exposure are explicit threats (spec §18.1).

## Decision

- Provider-agnostic `LlmProvider`; adapters for Anthropic, OpenAI, and OpenAI-compatible endpoints; default model `claude-opus-5-5`; tenants may change provider/model or disable AI (D19).
- Canonical tool names per spec §12.1 (D6). Every call is Zod-validated and authorized against the caller's `TenantContext`; out-of-scope IDs return `not_found`.
- Limits: 12 tool calls, 120 s per run, 15 s per tool, 64 KB per result.
- Numbers come from deterministic services. Answers cite evidence `[E<n>]`; a validator checks citations and numbers, retries once, then marks the answer `unverified`.
- Only `proposeAction` changes state, and it only creates a pending proposal requiring approval.
- Excluded from LLM context: credentials, PII records, source code, environment variables, raw logs, data-inspection values.

## Consequences

- Answers are slower than free-form chat but auditable.
- Disabling AI leaves dashboards, alerts, and deterministic reports working.

## References

- Spec §4.9, §12, §18.1, §18.2
- Master plan D6, D19; tasks M14.1–M14.3
- Workbook WB-14
