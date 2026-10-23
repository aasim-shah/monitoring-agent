# Handoff — M9.4 Assets UI

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-23 |
| **Branch** | `feat/m9-discovery-graph` |
| **Plan** | M9 plan Task 5 |
| **Workbooks** | WB-10 §8 screens, UC-10-04/09/10/11 |

## Delivered

- **Assets page** at `/orgs/:orgId/products/:productId/assets`. The nav item "Assets" now requires `asset.view`.
  - **Run discovery** button, shown with `product.manage`.
  - **Inventory:** filter by type and lifecycle; names link to the asset detail.
  - **Review** (with a count): proposed and drifted edges show confidence, rule, and the first piece of evidence, with **Confirm** and **Reject** (`relationship.verify`). Alias candidates show **Merge** and **Keep separate** (`product.manage`).
  - **Topology** (React Flow `@xyflow/react` 12.12.0): websites and domains, then hosts and workers, then services and databases, then the rest. Verified edges are solid, proposed edges dashed, drifted edges amber; each edge is labelled with its type and confidence. Clicking a node opens its detail.
  - **Coverage:** cards for assets, verified relationships, items to review, missing assets, and stale assets, plus counts by type.
- **Asset detail** at `/orgs/:orgId/products/:productId/assets/:assetId`: identity, source, lifecycle, first and last seen, attributes, relationships (linked), and **If this fails** (impact: Confirmed, Potential, or Unknown, with hops and path). **Retire** is shown with `product.manage`.
- **Pure layout function:** `lib/topology.ts` `toFlow()`.

## Tests

`pnpm --filter @pcp/web test` → 107 passed. The 7 new tests cover:
- the layout tiers
- edge styles by verification
- review confirm, reject, and merge
- actions hidden without permission, and the empty queue
- the inventory type filter and links
- impact classes and paths
- the empty impact state

The production build passes.
