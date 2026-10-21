# ADR 0006: Agent identity and mTLS

Status: Proposed
Date: 2026-10-22
Deciders: tech lead, security owner

## Context

Agents run in customer networks, connect outbound only, and must be individually identifiable and revocable (spec §6.4, §8.2, §18.1 agent impersonation).

## Decision

- Enrollment exchanges a short-lived, hashed, use-limited token for a per-agent certificate; the token is never a permanent credential.
- Agent CA: offline root signs an intermediate held by the API (`AGENT_CA_KEY`). Certificates are ECDSA P-256, `CN=<agentId>`, EKU `clientAuth`, valid 30 days, rotated at day 20; the old certificate stays valid 1 h after rotation (D11).
- Private keys are generated on the host; only CSRs leave it.
- Caddy terminates TLS for `agent.` and `ingest.` hosts with `client_auth require_and_verify` and forwards the certificate fingerprint in `X-Client-Cert-Fingerprint`; backends trust that header only from the Caddy network address (D10).
- Revocation is checked in PostgreSQL with a cache of at most 30 s on every gateway.
- Agent messages never carry tenant identifiers; gateways resolve them from the agent record.

## Consequences

- Revocation is near-immediate without CRL/OCSP infrastructure.
- Agents offline longer than certificate validity must re-enroll.

## References

- Spec §6.4, §8.2, §18.1
- Master plan D10, D11; tasks M5.1–M5.6
- Workbook WB-03
