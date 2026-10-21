# ADR 0015: Google authorization

Status: Proposed
Date: 2026-10-22
Deciders: tech lead, security owner

## Context

Customers expect "sign in with Google, allow access, done". Service-account JSON keys are commonly blocked by organization policy and are long-lived secrets (spec §7.2).

## Decision

- Login and data access are separate: login requests only `openid email profile`; "Connect Google" requests the read scope set in spec §7.2.2.
- Authorization code flow with PKCE, `state` (10 min, session-bound), `access_type=offline`, `prompt=consent`, `include_granted_scopes=true`.
- Refresh tokens are encrypted (ADR 0004); granted scopes are recorded and drive per-service status; `invalid_grant` sets `reauthorization_required`.
- `adwords` permits writes; the Ads connector exposes only `search`/`searchStream`.
- No service-account keys are created or downloaded. Keyless service-account mode uses one platform service account per tenant or per-call ownership checks.

## Consequences

- Google OAuth verification and Ads developer-token approval are external lead-time items started in week 1.
- A connection depends on the Google user who granted it; the UI shows that identity.

## References

- Spec §7.2
- Master plan tasks M13.1–M13.4; Review Focus #4
- Workbook WB-08
