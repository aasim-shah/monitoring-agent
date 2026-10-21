# ADR 0013: Agent installation methods

Status: Proposed
Date: 2026-10-22
Deciders: tech lead, security owner

## Context

Customers may ask the vendor to install agents using root or SSH passwords. Storing such credentials would make the platform a single point of compromise for every tenant (spec §8.11).

## Decision

- Supported: self-install one-liner, Ansible role, cloud-init snippet, Docker Compose agent profile (MVP); cloud remote-run (post-pilot); assisted SSH install through the opt-in installer runner.
- Assisted install uses a one-time ed25519 key per session (password only as a last resort, memory-only, single use), requires host-key fingerprint confirmation, runs only the signed install script, cleans up its key and user, connects from fixed egress IPs, and audits every step.
- The platform never stores root passwords or keeps permanent SSH access; after install all management uses OpAMP.

## Consequences

- Non-technical customers have a safe assisted path.
- `install_sessions` must never contain credential columns (schema test).

## References

- Spec §4.12, §8.7, §8.11
- Master plan tasks M6.7, M17.1–M17.3
- Workbook WB-05
