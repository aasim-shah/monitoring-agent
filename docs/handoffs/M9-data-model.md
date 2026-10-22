# Handoff — M9 data model (migration 0006)

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-23 |
| **Branch** | `feat/m9-discovery-graph` |
| **Plan** | M9 plan Task 1 |
| **Workbooks** | WB-10 §6, BR-10-01/02/05/08 |

## Delivered

**Tables.** All seven have forced RLS; `TENANT_TABLES` now lists 31 tables.

| Table | Purpose |
|---|---|
| `assets` | `asset_type`, `name`, `lifecycle`, `source`, `identity_key`, redacted `attributes`, first/last seen, `missed_runs`, `retired_at`. Unique `(organization_id, identity_key)`: never shared across organizations. |
| `asset_aliases` | Weak-match candidates (`open`, `merged`, `kept_separate`) |
| `asset_observations` | Redacted observation history |
| `product_assets` | Links an asset to one or more products (shared host), with an optional environment |
| `asset_relationships` | `relationship_type`, `confidence numeric(3,2)`, `verification` (`proposed`, `verified`, `rejected`, `drifted`), `rule_id`, `verified_by_user_id`. Unique `(source, target, type)`. |
| `relationship_evidence` | `kind` (`direct`, `ip_match`, `connection`, `name`, `manual`, `contradiction`) with `detail` |
| `discovery_runs` | Per product and source; reuses the `run_status` enum (`running`, `succeeded`, `failed`) |

**Column.** `agents.last_seen_ip` holds the egress IP seen by the edge proxy.

## Tests

`pnpm --filter @pcp/database test` → 82 passed:
- the RLS suite covers the seven new tables
- one asset identity per organization, with the same key allowed in another organization
- one edge per source, target, and type
