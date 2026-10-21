# ADR 0008: Connector SDK contract

Status: Proposed
Date: 2026-10-22
Deciders: tech lead

## Context

Connectors must be versioned, declare capabilities discoverable by UI and AI, and be addable without changing orchestration code (inital.md §6, spec §9).

## Decision

- Capability set (D5): `authenticate`, `config_validation`, `validate`, `discover`, `sync`, `health`, `metrics`, `events`, `webhook_registration`, `credential_refresh`, `actions`.
- A connector declares a capability if and only if it implements the matching method; the registry rejects mismatches at boot.
- The runtime loads a connection only after verifying the authenticated context and product/resource assignment; connectors never set tenant identity.
- Shared bounded HTTP client (timeout 10 s, 5 MB, 3 retries with jitter, `Retry-After`), per-provider rate limits, circuit breakers, structured logging with redaction.
- Connection statuses and reasons per spec §9.1.
- Mock connectors live only in `packages/connectors/mock` and are excluded from production images.

## Consequences

- New providers are packages with contract tests; no central code change.
- Capability declarations drive UI wizards and AI tool availability.

## References

- Spec §9, §9.1
- Master plan D5; tasks M4.2, M4.3
- Workbook WB-02
