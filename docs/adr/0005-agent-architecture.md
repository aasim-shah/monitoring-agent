# ADR 0005: Host agent architecture

Status: Proposed
Date: 2026-10-22
Deciders: tech lead, platform engineer

## Context

The agent must collect host and service telemetry with low overhead, use standard protocols, be remotely configurable, and never offer arbitrary execution (spec §4.5, §8.6, §11.4).

## Decision

- Host components (D12): `pcp-agentctl` (enroll, rotate, status, uninstall), upstream `opampsupervisor` (manages and upgrades the collector), `pcp-otelcol` (OpenTelemetry Collector distribution built with `ocb`, including the custom `pcpcontrol` extension), optional `pcp-helper` (root, opt-in, D20).
- Configuration is delivered through OpAMP by `apps/opamp-server` (Go, `opamp-go`), which reads effective configuration from the API (D13).
- One-off work (live boost, log tail, inspection, actions) uses signed tasks with a TTL over long-poll `GET /agent/v1/tasks?wait=25`; streaming results use `POST /agent/v1/streams/:sessionId/chunks` (D14).
- Kafka JVM metrics use the Prometheus JMX exporter Java agent scraped by the `prometheus` receiver; the collector `jmx` receiver is not bundled (D25).

## Consequences

- Maintained upstream receivers replace custom collectors.
- Binary size and memory grow with each component; an RSS budget is enforced per release (M6.1).
- The supervisor keeps the last good configuration when a pushed configuration fails.

## References

- Spec §4.5, §8, §11.4
- Master plan D12, D13, D14, D25; tasks M6.1–M6.4
- Workbooks WB-03, WB-04
