# ADR 0009: Asset identity and knowledge graph

Status: Proposed
Date: 2026-10-22
Deciders: tech lead

## Context

The product knowledge graph is the core data model (spec §1). Assets come from many sources and must be deduplicated without unsafe merges (spec §10.3).

## Decision

- Graph in PostgreSQL (`assets`, `asset_relationships`, evidence tables); no graph database until traversal performance requires it.
- Identity: provider stable ID scoped by connection, then agent identity for hosts; weak signals (names, IPs) create alias candidates only; never merge across organizations.
- Relationship types (D3): spec §10.4 list including `DEPLOYS`. Verification states: `proposed`, `verified`, `rejected`, `drifted`.
- Lifecycle (D4): `discovered`, `active`, `unreachable`, `missing` (3 completed runs unseen), `retired`, `manually_managed`.
- Auto-verification only at confidence ≥ 0.9 with direct observation; contradicting evidence marks verified edges `drifted`.
- Product scoping (D7) applies to every traversal.

## Consequences

- Review queues are part of normal operation; the UI must make them efficient.
- Recursive CTE traversal is bounded (depth 6).

## References

- Spec §10, §14.2
- Master plan D3, D4, D7; tasks M9.1–M9.3
- Workbook WB-10
