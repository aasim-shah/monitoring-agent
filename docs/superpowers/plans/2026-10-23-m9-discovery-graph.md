# M9 Discovery, Graph, and Topology Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each product gets an evidence-backed graph of what it runs on:

| Asset | Source |
|---|---|
| Hosts | agents |
| Services on those hosts | agent inventory, monitoring packs |
| Databases | private connections |
| Websites and domains | product configuration |

Relationships between these assets carry confidence and verification state. Users can review the graph (confirm, reject, correct), browse it as a topology, and ask "what breaks if this fails", with product scoping enforced everywhere.

**Architecture:**
- **Discovery engine** (`packages/discovery-engine`):
  - `ingestObservation` validates, redacts, normalizes, matches, and upserts an observation inside the tenant's RLS context. A strong match uses the provider's stable ID or the agent identity; a weak match by name or IP creates an alias candidate.
  - `proposeEdge` applies the pinned confidence rules and the verification state machine. Lifecycle passes mark assets that a completed run did not see.
- **Sources and correlation rules** are in the API (`modules/discovery`):
  - A *discovery run* for a product reconciles its sources: hosts, inventory services, private databases, and product domains. The run starts on demand, and also when an agent posts inventory or a private connection is validated.
  - It then evaluates the rules `host-to-service` and `dns-to-host`. DNS-to-host compares the domain's A/AAAA records with the agent's egress IP, which Caddy reports at heartbeat.
- **Graph API** (`modules/assets`): inventory, detail, relationships, verify/reject/correct, manual assets and edges, retire, alias resolution, topology, coverage, and impact. Impact is a scoped recursive CTE with depth 4 by default and 6 at most.
- **Web:** the Assets page has four tabs: Inventory, Review, Topology (React Flow), and Coverage. Each asset has its own detail page.

**Tech Stack:** Prisma 6 and PostgreSQL 17 (forced RLS, recursive CTE), NestJS 11, Next.js 15, `@xyflow/react` 12.12.0, Testcontainers, Playwright.

**Spec:** spec §4.8, §6.5, §10, §15.4, §16.3, §21; master plan M9.1–M9.4, D3, D4, D7; WB-10.

**Deferred:**
- Cloudflare, GitHub, GA4/Firebase, and Prometheus sources and their rules (`repo-to-service`, `prometheus-target`, `website-to-api`, `app-to-analytics`), which arrive with their connectors (M7, M13). M9 ships the rule interface plus `host-to-service`, `dns-to-host`, and `name-similarity`.
- `service-connections`, which needs TCP connection evidence from the agent (a later agent scraper).
- Incident-driven `confirmed` impact class (M12). Until then, `confirmed` means the dependent's own health check is failing.

## Global Constraints

- **BR-10-01:** never merge assets across organizations (RLS plus an organization-scoped unique identity).
- **BR-10-02:** never merge on a name alone. A weak match creates an alias candidate for review.
- **BR-10-03:** an edge is auto-verified only at confidence ≥ 0.9 with direct observation. Pinned confidences:

  | Evidence | Confidence |
  |---|---|
  | Direct provider or agent fact | 0.95 |
  | IP match | 0.8 |
  | Connection evidence | 0.6 (0.4 on NAT or a shared IP) |
  | Name similarity | 0.3 |

- **BR-10-04:** a confirmed edge is never silently deleted. Contradicting evidence moves it to `drifted`.
- **BR-10-05:** every edge stores source, target, type, evidence, confidence, verification state, and timestamps.
- **BR-10-06 / D7:** product-scoped roles see only assets linked to their products, and only edges whose both ends are visible.
- **BR-10-08:** secrets in observation attributes are redacted before storage.
- **Lifecycle:** `discovered → active → unreachable/missing → retired`, plus `manually_managed`. An asset becomes `missing` after 3 consecutive completed runs of its source that did not see it.

## Review Focus

1. **Shared host (TC-10-06).** Host H serves FireMaps and Product B. An analyst scoped to B sees H and B's services, never FireMaps' services or edges. Impact from H for that analyst lists only B's services: no names, IDs, or counts from FireMaps. Covered in Task 4.
2. **Cycles and depth.** In A→B→A, traversal terminates and respects the depth limit. Covered in Task 4.
3. **Same hostname in two organizations, and same name with different provider IDs.** Two assets each time, plus an alias candidate, never a merge. Covered in Task 2.
4. **A host's IP changes behind the same DNS name.** The old `ROUTES_TO` edge drifts or stays proposed, and a new edge is proposed. A verified edge is never deleted. Covered in Task 3.
5. **Secret-looking attributes** (`password=`, tokens, connection URLs with credentials) are redacted before storage. Covered in Task 2.

---

### Task 1: Data model (migration 0006)

**Files:** `packages/database/prisma/schema.prisma`, `migrations/0006_asset_graph/migration.sql`, `src/tables.ts`, RLS tests.

**Interfaces** (every table has `organization_id` with forced RLS):

| Table | Columns and constraints |
|---|---|
| `assets` | `id`, `asset_type` (`host`, `service`, `database`, `website`, `domain`, `repository`, `worker`, `external`), `name`, `lifecycle` (enum above), `source` (`agent`, `connector`, `product_config`, `manual`), `identity_key`, `attributes jsonb`, `first_seen_at`, `last_seen_at`, `missed_runs int`, `retired_at`; unique `(organization_id, identity_key)` |
| `asset_aliases` | `id`, `asset_id`, `candidate_asset_id`, `reason`, `status` (`open`, `merged`, `kept_separate`), `resolved_by_user_id` |
| `asset_observations` | `id`, `asset_id`, `source`, `observed_at`, `attributes jsonb` (redacted); last 20 per asset |
| `product_assets` | `product_id`, `asset_id`, `environment_id?`; primary key `(product_id, asset_id)` |
| `asset_relationships` | `id`, `source_asset_id`, `target_asset_id`, `relationship_type` (`HOSTS`, `ROUTES_TO`, `CONNECTS_TO`, `DEPENDS_ON`, `DEPLOYS`, `MONITORED_BY`, `REPORTS_TO`, `DEPLOYED_ON`), `confidence numeric(3,2)`, `verification` (`proposed`, `verified`, `rejected`, `drifted`), `rule_id`, `created_at`, `updated_at`, `verified_by_user_id?`; unique `(source, target, type)` |
| `relationship_evidence` | `id`, `relationship_id`, `kind` (`direct`, `ip_match`, `connection`, `name`, `manual`, `contradiction`), `detail jsonb`, `observed_at` |
| `discovery_runs` | `id`, `product_id`, `source`, `status` (`running`, `completed`, `failed`), `started_at`, `completed_at`, `stats jsonb` |

Also `agents.last_seen_ip`.

- [ ] Failing tests: the RLS suite covers the 7 new tables; uniqueness of identity per organization. Implement, pass, write handoff `M9-data-model.md`, commit.

### Task 2: Discovery engine

**Files:** `packages/discovery-engine/src/{redact,normalize,ingest,edges,lifecycle,index}.ts` plus `*.int.test.ts` (Testcontainers database through test-support).

**Interfaces:**
- `ingestObservation(tx, org, o: { source; assetType; identity: { kind: 'stable', key } | { kind: 'weak', name, ip? }; name; attributes; productId?; environmentId? }) → { assetId, created, aliasCandidateId? }`.
  - **Stable identity:** `stable:<key>` is upserted, `last_seen_at` refreshed, `missed_runs` set to 0, and a `discovered` asset becomes `active` when seen again.
  - **Weak identity:** creates a new asset, plus an alias candidate when an asset with the same name (or IP) exists in the organization.
  - `productId` links the asset to the product through `product_assets`.
- `redactAttributes(attrs)`:
  - keys matching `/pass|secret|token|key|credential|auth/i` → `[redacted]`
  - values matching `://user:pass@`, `Bearer `, or long high-entropy tokens → `[redacted]`
- `proposeEdge(tx, org, { source, target, type, confidence, evidenceKind, direct, detail, ruleId })`:
  - creates the edge, or adds evidence and raises confidence to the max seen
  - verifies it when `confidence ≥ 0.9 && direct`
  - leaves `rejected` edges as rejected, unless new direct evidence at ≥ 0.9 arrives, which makes them `proposed` again
- `contradictEdge(tx, edgeId, detail)`: `verified → drifted` with `contradiction` evidence.
- `completeRun(tx, run, seenAssetIds)`: assets of that product and source that the run did not see get `missed_runs + 1`, and become `missing` at 3. `manually_managed` and `retired` assets are skipped.

- [ ] Failing tests:
  - TC-10-01: the same hostname in two organizations gives two assets.
  - TC-10-02: the same name with different stable IDs gives two assets plus an alias candidate.
  - TC-10-03: missing after 3 runs, not after 2.
  - TC-10-04: a name-only edge stays proposed.
  - TC-10-05: contradiction gives drifted.
  - TC-10-08: redaction.
  - Re-ingest refreshes the asset, with no duplicate.

  Implement, pass, write handoff `M9-discovery-engine.md`, commit.

### Task 3: Sources and correlation rules

**Files:** `apps/api/src/modules/discovery/{discovery.service,sources,rules/host-to-service,rules/dns-to-host,rules/name-similarity}.ts` plus `discovery.int.test.ts`. The agents heartbeat records `last_seen_ip`, taken from `X-Forwarded-For` only when the socket peer is a trusted proxy.

**Interfaces:**
- `DiscoveryService.run(ctx, productId) → { runId, assets, edges }`. The run collects these sources:

  | Source | Assets created |
  |---|---|
  | Agents in the product | `host`, identity `agent:<id>`, with hostname, OS, and egress IP; private workers become `worker` assets |
  | Inventories | `service`, identity `agent:<id>/<pack>`, plus a `HOSTS` edge host→service at 0.95, direct, so verified |
  | Private connections scoped to the product | `database`, identity `connection:<id>`, with the engine and status |
  | `product.domains` | `website`, identity `domain:<host>`, source `product_config` |

  Then it evaluates the rules:
  - `dns-to-host`: resolve A/AAAA records (injectable resolver). A matching host egress IP proposes `ROUTES_TO` website→host at 0.8. If a verified `ROUTES_TO` edge points to a host whose IP no longer matches, it is contradicted (drifted).
  - `name-similarity` (0.3) proposes `CONNECTS_TO` between a database asset and a same-engine service on the same organization's hosts. It is never auto-verified.

  Finally it completes one discovery run per source.
- **Triggers:**
  - `POST /api/v1/products/:id/discovery/run` (`product.manage`)
  - after an agent posts inventory (run for that agent's product, debounced to one per minute)
  - after a private connection is validated

- [ ] Failing tests (Testcontainers API):
  - a product with a host, inventory (redis, postgresql), a private database, and a domain gives the expected assets and edges (HOSTS verified, ROUTES_TO proposed)
  - the IP change case gives drifted plus a new proposal
  - a rerun creates no duplicates
  - XFF from an untrusted peer is ignored

  Implement, pass, write handoff `M9-sources-rules.md`, commit.

### Task 4: Graph API and impact

**Files:** `apps/api/src/modules/assets/{assets.controller,assets.service,impact.sql}.ts` plus tests, and OpenAPI.

**Routes** (WB-10 §7; products use `:productId`):

| Route | Permission | Notes |
|---|---|---|
| `GET /products/:productId/assets?type&lifecycle&source` | `asset.view` | |
| `GET /assets/:id` | `asset.view` | Detail with recent observations |
| `GET /assets/:id/relationships` | `asset.view` | |
| `GET /assets/:id/impact?depth` | `asset.view` | |
| `POST /relationships/:id/verify` | `relationship.verify` | |
| `POST /relationships/:id/reject` | `relationship.verify` | |
| `POST /relationships` | `relationship.verify` | Manual edge, verified, `manual` evidence |
| `POST /relationships/:id/correct` | `relationship.verify` | `{ targetAssetId?, type? }`: the old edge is rejected and a new one verified, both audited |
| `POST /assets` | `product.manage` | Manual asset, `manually_managed` |
| `POST /assets/:id/retire` | `product.manage` | |
| `POST /asset-aliases/:id/resolve` | `product.manage` | `{ action: merge \| keep_separate }`; merge moves edges, links, and observations onto the kept asset |
| `GET /products/:productId/topology` | `asset.view` | Nodes and edges, no rejected edges |
| `GET /products/:productId/coverage` | `asset.view` | Counts by lifecycle and verification, assets without telemetry, stale assets |
| `GET /products/:productId/review` | `asset.view` | Proposed and drifted edges, open aliases |

**Scope (D7):** an asset is visible when linked to one of the caller's products. An edge is visible only when both of its ends are visible. A scoped caller never sees an invisible asset's ID or name.

**Impact:**
- A recursive CTE walks reverse dependency edges, from dependents to the start asset, over `DEPENDS_ON`, `CONNECTS_TO`, `ROUTES_TO`, `DEPLOYED_ON`, and `HOSTS`. Rejected edges are skipped, visited nodes are tracked, and depth is clamped to ≤ 6.
- **Classes:**
  - `confirmed`: the dependent has failing health (`connection_health` latest not ok, or `agent` degraded)
  - `potential`: reached only through verified edges or edges with confidence ≥ 0.8
  - `unknown`: everything else
- The scope filter is applied inside the query.

- [ ] Failing tests:
  - Review Focus #1: the FireMaps and B shared-host fixture
  - Review Focus #2: a cycle, plus the depth clamp
  - verify, reject, and correct are audited; correct leaves one rejected edge and one verified edge
  - a viewer cannot verify (404)
  - alias merge moves edges
  - coverage counts

  Implement, pass, write handoff `M9-graph-api.md`, commit.

### Task 5: Assets UI

**Files:** `apps/web/app/(app)/orgs/[orgId]/products/[productId]/assets/{page,[assetId]/page}.tsx`, `components/assets/{inventory-table,review-queue,topology-graph,coverage-cards,asset-detail}.tsx`, and nav (Assets enabled).

**Behavior:**
- **Inventory:** filters by type, lifecycle, and source, plus a "Run discovery" button.
- **Review:** proposed and drifted edges with evidence and confidence, Confirm and Reject actions, and alias candidates (Merge, Keep separate).
- **Topology:** React Flow with layered layout by type (website → host → service/database). Badges show verified (solid edge), proposed (dashed), and drifted (amber). Filters cover type and verification. Clicking an edge opens an inspector with evidence and actions.
- **Coverage:** count cards.
- **Asset detail:** identity, source, lifecycle, last seen, attributes, relationships, impact list, and a Retire button.

- [ ] Failing tests:
  - the review queue confirms and rejects with the right calls
  - the inventory filters
  - the topology builds nodes and edges with styles per verification state (pure function `toFlow`)
  - asset detail shows impact classes

  Implement, pass, write handoff `M9-assets-ui.md`, commit.

### Task 6: Exit gate, deploy, docs

- [ ] Playwright (`tests/e2e/assets.spec.ts`) against the Compose stack. Seed a FireMaps-like fixture through the API: an enrolled host with an inventory (redis, postgresql), a domain on the product, and a private database. Then run discovery, confirm one proposed edge, reject one, and check that the coverage counts match the fixture.
- [ ] Full pipeline once, deploy (migration 0006), browser check on production, WB-10 checklist, board, `M9-execution-log.md`.
