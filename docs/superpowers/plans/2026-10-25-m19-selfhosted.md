# M19 Remainder — Self-hosted Packaging, Load Baselines, Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Finish what M19 can deliver without outside people:
- **M19.4 self-hosted packaging:** OIDC sign-in, a local LLM endpoint, a platform AI switch, and install, upgrade, and backup runbooks.
- **M19.2:** k6 load baselines recorded in `docs/runbooks/capacity.md`.
- **M19.6:** customer, connector-development, and security documentation.

The external pentest (part of M19.1) and the pilot (M19.7) need people and are documented as such.

**Architecture:**
- **OIDC:** a generic OpenID Provider sign-in that discovers the provider's endpoints and keys, uses PKCE and a nonce, and verifies the ID token against the provider's JWKS. It is linked by `users.oidc_subject = <issuer>#<sub>`.
- **Login page:** reads `GET /api/v1/auth/providers` at runtime, so self-hosted images need no rebuild.
- **AI:** `AI_PROVIDER=local` with `AI_LOCAL_BASE_URL` and a model talks to any OpenAI-compatible endpoint. `AI_DISABLED=1` turns AI off for the whole platform; reports carry no narrative.
- **Load tests:** k6 in a container against the local Compose stack, never against the shared VPS.

**Tech Stack:** NestJS, jose, Prisma migration 0018, Next.js, k6 (grafana/k6), Markdown.

**Spec:** spec §19 (operations), §24 (pilot); master plan M19.2, M19.4, M19.6; WB-17.

## Global Constraints

- **No load against production:** load tests never target the shared production VPS (other customers' sites run there).
- **No published SLO:** no numeric SLO is advertised before baselines exist (spec §19.2). `capacity.md` records measured numbers and the machine they ran on.
- **OIDC is identity only:** `openid email profile`, and a verified email is required. An unverified local account's password is discarded on linking, as with Google.

## Review Focus

1. **OIDC provider gives `email_verified: false`:** sign-in is refused.
2. **Issuer mismatch between discovery and the ID token:** the token is refused.
3. **`AI_PROVIDER=local` without a base URL or model:** startup fails with a clear message.
4. **`AI_DISABLED=1` with keys still set:** no provider is ever called.

### Task 1: OIDC, local LLM, AI switch (code)
- Done in this branch; tests: identity OIDC int, ai-orchestrator env, api ai-disabled, worker narrative disabled, web SSO buttons.

### Task 2: Self-hosted runbooks
- `docs/runbooks/self-hosted-install.md`, `self-hosted-upgrade.md`, `self-hosted-backup.md`, and `.env.example` entries for OIDC, the local LLM, AI_DISABLED, the retained-logs and rollups profiles, and the installer runner.

### Task 3: Load baselines
- `tests/load/{api.js,ingest.js,agents.js}` (k6) plus `tests/load/run.sh`. Baselines go in `docs/runbooks/capacity.md`.

### Task 4: Documentation
- `docs/customer/onboarding.md`, `docs/connector-development/README.md`, `docs/security/whitepaper.md`, and the board, workbooks, and memory.
