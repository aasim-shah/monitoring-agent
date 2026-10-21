# ADR 0012: Deployment modes and bootstrap

Status: Proposed
Date: 2026-10-22
Deciders: tech lead

## Context

The product ships as managed SaaS first and fully self-hosted second from one architecture (spec §3). inital.md requires private HTTP bootstrap and production HTTPS.

## Decision

- Build managed SaaS first; self-hosted uses the same images and `compose.yaml` with `DEPLOYMENT_MODE=self_hosted` (D1). CI runs the Compose smoke test in both modes.
- `BOOTSTRAP_MODE=private_http` serves HTTP for first-admin setup; agent enrollment, OAuth, and webhooks stay disabled until HTTPS is configured (D2).
- Caddy is the only service publishing ports; data services stay on an internal network.

## Consequences

- Mode-specific behavior must be configuration-driven, never forked code.
- Hybrid/dedicated deployments (spec §3.3) are later work.

## References

- Spec §3, §17
- Master plan D1, D2; tasks M1.3, M19.4
- Workbook WB-17
