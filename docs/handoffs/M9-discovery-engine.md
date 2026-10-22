# Handoff — M9.1 Discovery engine

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-23 |
| **Branch** | `feat/m9-discovery-graph` |
| **Plan** | M9 plan Task 2 |
| **Workbooks** | WB-10 UC-10-01..08, BR-10-01..05/08, TC-10-01..05/08 |

## Delivered

`@pcp/discovery-engine` (`packages/discovery-engine`). Every function runs inside the caller's tenant transaction (`withTenant`):

- **`ingestObservation(tx, org, observation)` → `{ assetId, created, aliasCandidateId? }`:**
  - **Redaction:** attributes are redacted before storage (`redactAttributes`).
  - **Stable identity:** an asset is upserted by `(organization_id, identity_key)`. A repeat sighting refreshes the name, attributes, `last_seen_at`, and `missed_runs = 0`, and turns `discovered`, `missing`, or `unreachable` into `active`.
  - **Weak identity:** always creates a new asset (`weak:<uuid>`).
  - **Alias candidates:** a new `host`, `website`, `domain`, or `repository` asset, or any weak one, whose name (or IP, for weak identities) matches an existing asset gets an **alias candidate**. Assets are never merged (BR-10-02).
  - **Observations:** the last 20 are kept per asset.
  - **Products:** the optional `productId` links the asset through `product_assets`.
- **`proposeEdge(tx, org, { source, target, type, confidence, evidenceKind, direct, detail, ruleId })`:**
  - creates an edge, or strengthens an existing one (confidence becomes the maximum seen) and adds evidence (last 20 kept)
  - auto-verifies only at `≥ 0.9 && direct` (BR-10-03)
  - **rejected** stays rejected unless strong direct evidence arrives, which sets it back to proposed
  - **drifted** waits for a person
- **`contradictEdge`:** `verified → drifted` with `contradiction` evidence. Nothing is ever deleted (BR-10-04).
- **`startRun` / `completeRun(tx, org, runId, seenAssetIds)`:**
  - every asset of the run's product and source that the run did not see gets `missed_runs + 1` and becomes `missing` at 3
  - retired and `manually_managed` assets are skipped
  - the run is recorded as `succeeded` with stats
- **Constants:** `CONFIDENCE` holds the pinned values: 0.95 direct, 0.8 IP, 0.6/0.4 connection, 0.3 name.
- **Redaction rules:**
  - secret-named keys (`pass`, `secret`, `token`, `apikey`, `credential`, `auth`, `private_key`, `key`, `session`, `cookie`)
  - credential values: Bearer tokens, GitHub/Stripe/OpenAI/Slack/AWS/`pcp_enr_` tokens, JWTs
  - URL passwords (`scheme://user:[redacted]@host`)

## Rulings

Alias candidates apply only to types whose names identify them. Services such as "Redis" repeat on every host by design.

## Tests

`pnpm --filter @pcp/discovery-engine test` → 8 passed (Testcontainers PostgreSQL with RLS):
- TC-10-01: the same key in two organizations gives two assets
- refresh: redacted attributes, product link, observations
- TC-10-02: the same name with different IDs, or a weak identity, gives an alias candidate
- TC-10-04: name-only stays proposed, direct ≥ 0.9 is verified, and evidence accumulates
- a rejected edge stays rejected on weak evidence and becomes proposed on strong evidence
- TC-10-05: drift
- TC-10-03: missing after 3 runs, not after 2; manually managed assets are untouched
- TC-10-08: redaction
