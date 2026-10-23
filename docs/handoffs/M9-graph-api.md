# Handoff — M9.3 Graph API and impact

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-23 |
| **Branch** | `feat/m9-discovery-graph` |
| **Plan** | M9 plan Task 4 |
| **Workbooks** | WB-10 UC-10-04..06/10..12, BR-10-04/06/07, TC-10-06/07, Review Focus #1 |

## Delivered

**Tenant resolution.** `pcp_resolve_asset_org`, `pcp_resolve_relationship_org`, and `pcp_resolve_asset_alias_org` were added to migration 0006 (not yet deployed). `TenantGuard` handles the resources `asset`, `relationship`, and `asset_alias` at organization level. Product scope is enforced by the service, because an asset can belong to several products.

**`AssetsService` and `AssetsController`** (`apps/api/src/modules/assets`):

| Route | Permission | Notes |
|---|---|---|
| `GET /products/:productId/assets?type&lifecycle&source` | `asset.view` | Excludes retired assets unless asked |
| `POST /products/:productId/assets` | `product.manage` | Manual `manually_managed` asset, audited |
| `GET /products/:productId/topology` | `asset.view` | Nodes plus edges between them, without rejected edges |
| `GET /products/:productId/coverage` | `asset.view` | Counts by lifecycle and type, edges by verification, stale assets (24 h) |
| `GET /products/:productId/review` | `asset.view` | Proposed and drifted edges with evidence, open alias candidates |
| `GET /assets/:id` | `asset.view` | Detail with the last 5 observations |
| `GET /assets/:id/relationships` | `asset.view` | Only edges whose other end is visible |
| `POST /assets/:id/relationships` | `relationship.verify` | Manual verified edge with `manual` evidence, audited |
| `GET /assets/:id/impact?depth` | `asset.view` | Recursive CTE; depth 4 by default, at most 6 |
| `POST /assets/:id/retire` | `product.manage` | Audited |
| `POST /relationships/:id/verify` and `/reject` | `relationship.verify` | Both ends must be visible, audited |
| `POST /relationships/:id/correct` | `relationship.verify` | The old edge is rejected and the new one verified (target or type changed), audited |
| `POST /asset-aliases/:id/resolve` | `product.manage` | `merge` or `keep_separate`, audited |

- **Scope (D7, Review Focus #1).** An asset is visible when it is linked to one of the caller's products. An edge is visible when both of its ends are. Impact only walks through visible assets. Anything invisible gets 404, and no name, ID, or count leaks.
- **Impact.**
  - It walks to dependents: `ROUTES_TO`, `DEPENDS_ON`, `CONNECTS_TO`, and `DEPLOYED_ON` point from dependent to dependency, while `HOSTS` points from dependency to dependent.
  - Rejected edges and cycles are skipped.
  - When several paths reach the same asset, it keeps the best one: all verified or confidence ≥ 0.8 first, then the shortest.
  - **Classes:**
    - **confirmed:** the dependent's own health is failing (the database's latest `connection_health` is not ok, or its agent is degraded or stale)
    - **potential:** reached through verified edges or edges with confidence ≥ 0.8
    - **unknown:** anything else
- **Merge.** The older asset is kept. Edges move to it; when the kept asset already has the same edge, the duplicate's evidence moves there, and an edge that would loop is dropped. Product links and observations move too. The merged asset is retired with `mergedInto`, and the discovery engine now redirects later observations of that identity to the kept asset (engine test added).
- **Discovery.** It now also includes **managed** database connections (Atlas, Supabase), with the attribute `managed: true`.
- **OpenAPI.** Typed entries for all routes above (`Asset`, `AssetRef`, `Relationship`, `RelationshipType`), and the client was regenerated.

**Rulings:**
- The manual asset route is `POST /products/:productId/assets` and the manual edge route is `POST /assets/:id/relationships`. Spec §15 lists `POST /assets` and `POST /relationships`, but the tenant guard needs a route parameter; the spec stubs remain in OpenAPI, unimplemented.
- Retire returns 200 with the asset.

## Tests

- `assets.int.test.ts` (5 tests):
  - shared-host scope across assets, relationships, topology, and impact, with no FireMaps leak and the owner seeing everything
  - impact: cycle, default depth 4, clamp to 6; a failing database is `confirmed` and a weak path `unknown`
  - verify, reject, and correct are audited, a viewer gets 404, and a cross-product edge gets 404
  - manual asset and edge, retire, alias merge moving edges
  - coverage counts
- Engine: 9 passed, including the merged-identity redirect.
- Full API suite: 34 files, 199 passed.
