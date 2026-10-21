# ADR 0004: Secret storage with envelope encryption

Status: Proposed
Date: 2026-10-22
Deciders: tech lead, security owner

## Context

Connector credentials must be encrypted, least-privileged, never echoed, and useless in a stolen backup (spec §14.4, §18.1).

## Decision

- AES-256-GCM with a random 256-bit data key per secret; the data key is wrapped by a key-encryption key from `MASTER_KEY` (base64, 32 bytes), stored with `key_version` (D9).
- AAD is `"<organization_id>:<connection_id>"`, binding each ciphertext to its row.
- Rotation: add a new key version, make it active, re-wrap data keys in a background job, then retire the old key.
- Deleting a connection deletes the wrapped key (crypto-shredding).
- Customer-side credentials (private databases, pack credentials) stay on customer hosts; the control plane stores only opaque references or relays sealed ciphertext it cannot decrypt (D24).

## Consequences

- Losing `MASTER_KEY` makes all stored credentials unrecoverable; key backup is a separate, documented procedure (WB-17).
- KMS/Vault integration can replace the env-provided key without changing the record format.

## References

- Spec §14.4, §18.1
- Master plan D9, D24; task M4.1
- Workbook WB-02
