# ADR 0001: Modular monolith API with separate workers

Status: Proposed
Date: 2026-10-22
Deciders: tech lead

## Context

The platform needs identity, tenancy, connectors, discovery, graph, telemetry query, incidents, AI, reports, and actions (spec §4.2). A small team must ship a pilot quickly, keep transactions simple, and deploy on one VPS with Docker Compose (inital.md §3, spec §17.4). Kubernetes and Kafka are excluded from the MVP.

## Decision

- One NestJS (Fastify) application, `apps/api`, organized as modules with explicit interfaces and dependency injection.
- Long-running and scheduled work runs in `apps/worker` (BullMQ on Redis), deployed separately.
- High-volume or OpenTelemetry-native paths are separate Go services: `opamp-server`, `ingest-gateway`, `installer-runner`, and the host agent (D12, D13, D15).
- Modules communicate in-process through injected services; cross-process communication uses queues or HTTP on the internal network.

## Consequences

- Simple deployment and transactions; one codebase to reason about.
- Module boundaries must be enforced by review and lint rules; otherwise the monolith couples.
- Revisit when team size or throughput demands service separation (spec §25).

## References

- Spec §4.2, §4.3, §17.4, §25
- Master plan D12, D13, D15; task M1.2
