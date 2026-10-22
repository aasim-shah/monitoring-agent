# Execution Log — M3 Dashboard Shell (+ CI dependency fixes)

| | |
|---|---|
| **Plan** | `docs/superpowers/plans/2026-10-22-m3-dashboard-shell.md` |
| **Branch** | `feat/m3-dashboard-shell` (from `main` at `a50d883`) |
| **Executed** | 2026-10-22, inline, test-first |

## Ledger

```text
# SDD ledger — plan: docs/superpowers/plans/2026-10-22-m3-dashboard-shell.md
Spec: spec §21, master plan M3, WB-01; branch feat/m3-dashboard-shell from main (main = M0–M2, pushed to origin).
Pre-flight: T1 api-client consumed by T2–T5 — consistent; T2 states/handleApiError consumed by T3–T5 — consistent; T4 nav/useApiQuery consumed by T5 — consistent; T6 exercises all.
Ruling: ROLE_PERMISSIONS/can move to @pcp/shared-contracts (browser needs them; tenant-security re-exports) — cost if wrong: none.
Ruling: unbuilt spec §21 sections shown as disabled nav items labelled with their milestone (honest IA, no fake pages) — cost if wrong: UX copy change.
Ruling: E2E runs against the real Compose stack with an override adding Mailpit for verification and invitation mail — cost if wrong: slower CI job.
Task 1: complete (commits a50d883..836d433, tests: pnpm turbo run test --filter @pcp/api-client →   Time:    46ms >>> FULL TURBO)
Task 2: complete (commits 836d433..f902a6e, tests: pnpm turbo run test --filter @pcp/web --filter @pcp/shared-contracts --filter @pcp/tenant-security →   Time:    22ms >>> FULL TURBO)
Task 3: complete (commits f902a6e..de32dd1, tests: pnpm turbo run test --filter @pcp/web →   Time:    2.937s )
Task 4: Ruling: added GET /api/v1/organizations/:orgId/products (product.view; product-scoped members see only their products) — overview and switcher need it; spec §15 had no list route — cost if wrong: none.
Task 4: complete (commits de32dd1..996036f, tests: pnpm turbo run test --filter @pcp/web --filter @pcp/api →   Time:    58ms >>> FULL TURBO)
Task 5: complete (commits 996036f..7441274, tests: pnpm turbo run test --filter @pcp/web --filter @pcp/api-client →   Time:    20ms >>> FULL TURBO)
Task 6: Ruling: e2e journeys passed on first run (UI already test-driven); validated detection by mutating the viewer role to admin → spec failed; restored — cost if wrong: none.
Task 6: Ruling: tests package typechecks with Bundler resolution for Playwright's extensionless imports — cost if wrong: none.
Task 6: complete (commits 7441274..db76a3c, tests: sh -c 'pnpm test:repo && pnpm test:e2e' →   2 passed (19.8m))
Final review: self-review (session policy: no subagents unless the user asks); no Critical/Important findings
Final: minor (deferred): forced MFA redirect (handleApiError → /mfa) drops the original path, so users land on /orgs after setup; pass next.
Final: minor (deferred): no Content-Security-Policy header yet (M19.1 hardening).
Final: minor (deferred): removing a member has no confirmation dialog.
```

## How to resume

- Next milestone: M4 (connector SDK, connection lifecycle, job framework). Expand master-plan M4 first.
- Prerequisites: `corepack enable`, Docker; Playwright Chromium for `pnpm test:e2e`.
