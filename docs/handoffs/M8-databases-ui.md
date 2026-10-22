# Handoff — M8 Databases page

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-23 |
| **Branch** | `feat/m8-private-worker` |
| **Plan** | M8 plan Task 6 |
| **Workbooks** | WB-07 §7 screens, UC-07-01..06 |

## Delivered

- **Page.** `/orgs/:orgId/products/:productId/databases`. The nav item "Databases" is now enabled and requires `connection.view`.
- **Private workers panel** (`components/databases/worker-panel.tsx`):
  - lists the product's `private_worker` agents with their status
  - "Add private worker" lets you choose an environment, then shows the one-time `docker load && docker run …` install command
- **Add database** (`add-database-dialog.tsx`):
  - fields: engine (PostgreSQL, MySQL, MongoDB; the port follows the engine), name, worker, host, port, database, TLS (on by default)
  - turning TLS off needs an explicit "Allow plaintext on this private network" confirmation; it is audited
  - shows the "create a read-only user" commands for the chosen engine
  - takes a secret name (default `<engine>-<name>`) and shows the snippet for `/etc/pcp-worker/secrets/<name>.yaml`
  - **Never asks for a password.** It saves `{ workerAgentId, secretRef, host, port, database, tls }`, then scopes the connection to the current product.
- **Database list** (`database-list.tsx`):
  - **Status:** Connected, Validating…, Worker offline (no data shown, never zeros), Permission denied, Failed (with a readable reason), Disconnected.
  - **Permission denied** explains why and offers "Allow anyway", the audited override. The button appears only for roles with `connection.configure`.
  - **Health columns:** connections / max, size (sum over databases or schemas, or one MongoDB database), replication lag, slow queries ("extension not installed", a count, or the top queries).
- **API change.** The agent summary gains `agentType` (`host` or `private_worker`) in the API and OpenAPI, with the client regenerated.

## Tests

- `pnpm --filter @pcp/web exec vitest run components/databases lib/nav`: 12 passed. Covered:
  - no password field
  - `secretRef` plus worker in the request
  - the read-only steps for each engine
  - the plaintext confirmation
  - the no-worker hint
  - list statuses, health, override visibility, worker offline
- API `fleet.int.test.ts` checks `agentType`.
