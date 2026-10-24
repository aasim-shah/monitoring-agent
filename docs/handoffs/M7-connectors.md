# Handoff — M7.2–M7.4 Cloudflare, GitHub, Prometheus, and Grafana connectors

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-24 |
| **Branch** | `feat/m7-integrations` |
| **Plan** | M7 plan Tasks 3–6 |
| **Workbooks** | WB-06 UC-06-02 – UC-06-09, BR-06-01 – BR-06-04 |

## Delivered

- **Cloudflare** (`packages/connectors/cloudflare`), with a scoped API token:
  - **Validate:** checks the token, then probes Zone Read and DNS Read. A missing permission is named, not thrown.
  - **Discover:** zones, DNS records, and certificate packs.
  - **Webhooks:** notifications signed with `cf-webhook-auth` become `dns_change` or `security_event`.
  - **Action:** `purge_cache` for M16, run only after approval.
- **GitHub** (`packages/connectors/github`), with a fine-grained personal access token instead of a GitHub App:
  - Every request passes a path allowlist.
  - **Validate:** `/user`, then repository access.
  - **Discover:** repositories, workflows, the 5 latest deployments, and the latest release.
  - **Webhooks:** checked with `x-hub-signature-256`. Handled events: `deployment_status`, failed `workflow_run`, `release`, `push` to the default branch, and revocation.
  - **Action:** `workflow_dispatch` for M16.
- **Prometheus, Mode A** (`packages/connectors/prometheus`):
  - **Validate:** build info.
  - **Discover:** the server and up to 1000 targets.
  - **Queries:** run on demand, with a 31-day range limit and an 11 000-point limit. Both are checked before anything is sent.
- **Grafana** (`packages/connectors/grafana`): health, then dashboard search. Dashboards become link targets.
- **Inventory to assets** (discovery service):
  - Scoped zones become `domain` assets, with ROUTES_TO edges to hosts by A/AAAA IP.
  - Scoped repositories become `repository` assets.
  - Prometheus targets attach to matched agent hosts, with a `service` per job.
- **Deployments reach the AI and reports:**
  - `getDeployments` reads change events from product-scoped GitHub connections.
  - The daily report has a deployments section. "Deployments" is missing only when no GitHub connection exists.

## Verify

```bash
for p in cloudflare github prometheus grafana; do pnpm --filter @pcp/connectors-$p test; done
pnpm --filter @pcp/api exec vitest run src/modules/discovery src/modules/ai src/modules/actions
```

## Decisions

- Provider base URLs can be overridden only together with `PCP_ALLOW_TEST_PROVIDERS=1`. Only the e2e stack sets it, and a compose test checks that the production compose files never do.
- Prometheus and Grafana run centrally for now. A private Prometheus waits for the private worker's connector set.

## Limitations

- Real Cloudflare and GitHub accounts need the user's own tokens. The connect wizard lists the exact permissions.
- The nightly live tests (TC-06-09) need stored test credentials and are not set up.
