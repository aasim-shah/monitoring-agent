# ADR 0007: Telemetry protocols, storage, and query isolation

Status: Proposed
Date: 2026-10-22
Deciders: tech lead, platform engineer

## Context

High-rate telemetry must not live in PostgreSQL (spec §11.1). Ingest must be multi-tenant, limit-enforced, and standard-protocol based (spec §11.4–11.7).

## Decision

- Wire formats: OTLP and Prometheus remote_write only.
- Ingest gateway (Go) authenticates the agent, overwrites `tenant_id`, `product_id`, `environment_id`, `agent_id`, adds VictoriaMetrics `extra_label` as defense in depth, and enforces per-agent and per-tenant limits (D15).
- Storage: single-node VictoriaMetrics and VictoriaLogs for MVP; cluster mode at scale (spec §11.12).
- Reads go through the API `telemetry-query` module, which adds `extra_label=tenant_id=<id>` and `extra_filters[]` for product scope (D16).
- vmalert evaluates per-tenant rule groups with group `params.extra_label` and `labels.tenant_id` (D17).
- Storage services listen only on the internal network.

## Consequences

- Single-node VictoriaMetrics has no native multi-tenancy; isolation depends on gateway-set labels and the query layer, so cross-tenant tests are mandatory.
- Native downsampling is an enterprise feature; long-term rollups use vmalert recording rules (M18.4).

## References

- Spec §4.10, §4.11, §11.4–11.7, §16.2
- Master plan D15, D16, D17; tasks M6.5, M6.6, M12.1
- Workbooks WB-04, WB-13
