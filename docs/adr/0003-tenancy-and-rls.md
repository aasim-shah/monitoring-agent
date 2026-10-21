# ADR 0003: Tenancy and row-level security

Status: Proposed
Date: 2026-10-22
Deciders: tech lead, security owner

## Context

Cross-tenant data leakage is the highest-impact risk (spec §18.1). `organization_id` is the primary authorization boundary; product and environment further restrict scope (spec §2). Pooled connections must not leak tenant context (spec §14.3).

## Decision

- Every tenant table has `organization_id`, `ENABLE` and `FORCE ROW LEVEL SECURITY`, and a policy `USING (organization_id = current_setting('app.organization_id', true)::uuid) WITH CHECK (same)` (D8).
- Application code accesses tenant data only through `withTenant(ctx, fn)`, which opens an interactive transaction and sets `app.organization_id` with `set_config(..., true)` (transaction-local).
- Database roles: `pcp_migrator` (owner, migrations only), `pcp_app` (no `BYPASSRLS`, owns nothing), `pcp_scheduler` (EXECUTE only on specific `SECURITY DEFINER` functions returning `(organization_id, entity_id)` pairs).
- Product scoping (D7): product-scoped roles see only assets linked through `product_assets`/`environment_assets`; out-of-scope access returns 404.
- Tenant identity always comes from the authenticated server-side context.

## Consequences

- Defense in depth: a missing service-layer check still cannot read another tenant's rows.
- Every new table needs RLS and a cross-tenant test (Definition of Done).
- Background jobs carry the organization ID set server-side at enqueue time and run inside `withTenant`.

## References

- Spec §2, §14.3, §18.1
- Master plan D7, D8; tasks M2.1, M2.2, M2.4; Review Focus #1, #5
- Workbook WB-01
