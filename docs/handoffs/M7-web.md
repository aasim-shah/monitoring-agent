# Handoff — M7.5 Integrations UI

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-24 |
| **Branch** | `feat/m7-integrations` |
| **Plan** | M7 plan Task 7 |
| **Workbooks** | WB-06 UC-06-02, UC-06-05, UC-06-10 |

## Delivered

- **Integrations page:** cards for Cloudflare, GitHub, Prometheus, and Grafana. Each connect wizard shows:
  - the exact token permissions, with optional ones marked
  - where the connector runs
  - what it collects and how often
  - what it can change
  - the configuration and credential fields
- **Connected list:** every connection scoped to this product. An organization-wide member also sees connections not scoped to any product yet, marked "not scoped yet".
- **Connection page:**
  - status, and the permissions the token lacks
  - discovered resources, with checkboxes to scope zones, repositories, or servers to this product. Scopes of other products are kept.
  - the webhook URL with a copy button, and where to paste it
  - the delivery log, recent changes, and sync history
  - Validate now, Discover now, Delete, and Replace credentials
- **Nav:** "Integrations" is enabled for `connection.view`.

## Tests

- **Web tests** (5): the Cloudflare wizard lists permissions and refuses an empty token; the GitHub wizard collects owner and repositories; scoping keeps other products' scopes; the webhook URL and delivery rows show; members who cannot configure see no changes. Also the nav test.
- **Playwright** `integrations.spec.ts`:
  1. Connect GitHub against a fake GitHub server.
  2. Scope one repository.
  3. A forged webhook gets 401; a signed one becomes a change event and a delivery row.
  4. The assistant no longer reports deployments as missing.
