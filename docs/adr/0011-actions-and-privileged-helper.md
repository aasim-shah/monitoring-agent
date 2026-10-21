# ADR 0011: Operational actions and the privileged helper

Status: Proposed
Date: 2026-10-22
Deciders: tech lead, security owner

## Context

Actions must be explicit, policy-constrained, approved, verified, and audited; arbitrary host execution is forbidden (spec §13.5, §18.1).

## Decision

- All action policies default to disabled. Production actions need an approver different from the requester. AI proposals always need approval.
- Execution uses Ed25519-signed, single-use tasks with a 10 min TTL.
- Host-level operations (service restart, Level 1 pack install) run only through `pcp-helper`: opt-in at install (`--enable-helper`), unix socket readable only by the `pcp-agent` group, verifies signature, expiry, and the customer-controlled allowlist `/etc/pcp-agent/helper.yaml` (D20).
- Initial adapters: Cloudflare cache purge (purge-everything needs a second approval), GitHub `workflow_dispatch` for allowlisted workflows, host service restart for allowlisted units.

## Consequences

- The platform can never act beyond what the customer allowlists on the host.
- Every adapter documents compensating procedures; rollback is not assumed.

## References

- Spec §13.5, §18.1, §18.3
- Master plan D20; tasks M16.1–M16.3
- Workbook WB-16
