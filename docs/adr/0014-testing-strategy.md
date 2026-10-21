# ADR 0014: Testing strategy

Status: Proposed
Date: 2026-10-22
Deciders: tech lead

## Context

Correctness, tenant isolation, and honest data are the product (spec §24). Mock data must never replace production integrations silently (inital.md §24).

## Decision

- Test-first for all production code. Vitest for TypeScript (NestJS via SWC), `go test` for Go, `node:test` for repository checks (D18).
- Integration tests use Testcontainers (PostgreSQL, Redis, VictoriaMetrics, vmalert).
- Connector contract tests run on recorded fixtures; live provider tests run nightly behind `LIVE_TESTS=1`.
- Security suites: RLS, route-enumeration cross-tenant matrix, response and log secret scans.
- End-to-end: Playwright for the dashboard; systemd containers for agent install across supported OSes; Compose smoke in both deployment modes.
- Load tests with k6 establish baselines before any SLO is stated.

## Consequences

- CI time grows with suites; heavy suites (smoke, agent end-to-end) run in parallel jobs.

## References

- Spec §24
- Master plan D18, §6.1, §6.2
- Workbook WB-18
