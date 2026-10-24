# Execution Log — M7 SaaS Integrations and Webhooks

| | |
|---|---|
| **Plan** | `docs/superpowers/plans/2026-10-24-m7-integrations.md` |
| **Branch** | `feat/m7-integrations` (stacked on `feat/m16-actions`) |
| **Executed** | 2026-10-24/25, inline, test-first. Final review was a self-review (no subagent). |
| **Deployed** | `https://monitor.aasimshah.com` (migration 0012; api, web, migrate, worker; other VPS sites unchanged) |

## Ledger

```text
# SDD ledger — plan: docs/superpowers/plans/2026-10-24-m7-integrations.md
Spec: spec §7, §7.1, §7.7, §11.4, §13.4; master plan M7.1–M7.5; WB-06; branch feat/m7-integrations stacked on feat/m16-actions.
Pre-flight: T1 tables consumed by T2 (webhook_deliveries, change_events), T3–T5 (inventory via the discover job), T6 (inventory → assets; change events → AI/reports) — consistent; T3/T4 executeAction consumed by the M16 executor — consistent; T2 ingestEvent contract consumed by T3/T4 — consistent.
Ruling: plan executed without separate review — user asked to complete everything — cost if wrong: re-plan.
Ruling: GitHub connects with a fine-grained PAT plus webhook secret instead of a GitHub App — user has no GitHub App and asked not to block — cost if wrong: add App auth in the client later.
Task 1: complete (commits 4053708..26ffc13, tests: database integrations+rls+schema-drift → 116/116; jobs 8/8)
Task 2: Ruling: webhooks are processed in the request (no queue) — events are small and normalization is a few rows; a burst only costs request time — cost if wrong: move to a queue job.
Task 2: complete (commits 26ffc13..ded44fe, tests: api webhooks 5/5 + connections 23; database integrations 5; runtime 18; sdk 55; mock 4; openapi 4/4)
Task 3: Ruling: provider base URLs can be overridden only with PCP_ALLOW_TEST_PROVIDERS=1 (test stacks), which allows exactly that private host — needed for API tests and the e2e stack without internet — cost if wrong: a misconfigured production env could point a provider at an internal host; the flag is checked by the compose test.
Task 3: complete (commits ded44fe..6899133, tests: cloudflare 7/7; runtime 20/20; api actions 14/14)
Task 4: complete (commits 6899133..6bf5e0f, tests: github 7/7; runtime registry 5/5)
Task 5: Ruling: Prometheus and Grafana run centrally only for now — the private worker has its own connector set (M8); private Prometheus waits for it — cost if wrong: a private Prometheus cannot be connected yet.
Task 5: complete (commits 6bf5e0f..e0357f3, tests: prometheus 4/4, grafana 2/2, registry 5/5)
Task 6: complete (commit 68df4f1, tests: api discovery+ai+reports 20/20, worker report-handlers 10/10, reports 25/25)
Task 7: Ruling: added GET connections/:id/{inventory,webhook-deliveries,change-events} (connection.view) — the detail page needs stored data; /resources calls the provider live — cost if wrong: three small read routes to maintain.
Task 7: Ruling: validation stores {missingPermissions} as JSON in connection_health.detail — the page must name what the token lacks and the runtime did not persist it — cost if wrong: older rows show no list.
Task 7: Ruling: saving scope sends other products' scopes back unchanged — setScopes replaces the whole list for org-wide callers — cost if wrong: none for product-scoped admins (server keeps theirs).
Task 7: complete (commit 9817da6, tests: web 167/167, api webhooks 6/6, runtime 15/15, api-client 5/5)
Task 8: Ruling: Caddyfile.local now routes /webhooks/* to the API (production and behind-proxy already did); bootstrap keeps refusing with 503 — the e2e stack runs the local config — cost if wrong: none.
Task 8: Ruling: the e2e stack runs a node:22 fake GitHub; only compose.e2e.yaml sets PCP_ALLOW_TEST_PROVIDERS, guarded by a compose smoke test — cost if wrong: none.
Task 8: fixed: the connection page remounted after saving scope and lost its notice — integrations.spec RED→GREEN.
Task 8: pipeline: format, lint, typecheck, turbo test 53/53 tasks, test:repo, openapi, go, smoke 20/20, Playwright 10/10, agent-e2e 6/6 (one earlier agent-e2e failure traced to a full Mac disk hanging Docker; rerun green).
Task 8: deployed 2026-10-25: migration 0012; api, web, migrate, worker; 22 sites unchanged; forged webhook 401; worker reached the Prometheus demo (11 targets) and Grafana play (264 dashboards).
Final review: self-review (no subagent tool used).
Final: minor (deferred): real Cloudflare and GitHub connections need the user's tokens; nightly live tests (TC-06-09) not set up.
Final: minor (deferred): no per-source webhook rate limit beyond the global limiter.
Final: minor (deferred): Prometheus and Grafana cannot run through the private worker yet.
Task 8: complete
```

## Connecting real accounts

- **Cloudflare:**
  1. Go to My Profile → API Tokens → Create Token → Custom token.
  2. Grant Zone: Zone: Read, Zone: DNS: Read, and Zone: SSL and Certificates: Read, limited to the zones you want. Cache Purge is needed only for approved purges.
  3. On the Integrations page, choose Connect Cloudflare and paste the token.
  4. To send events: Notifications → Destinations → Webhooks, with the URL shown on the connection page and a long random secret. Enter the same secret under Replace credentials.
- **GitHub:**
  1. Go to Settings → Developer settings → Fine-grained tokens.
  2. Set the resource owner to your user or organization, and choose the repositories.
  3. Grant Metadata, Contents, Actions, and Deployments, all read-only. Actions read and write is needed only for approved workflow runs.
  4. To send events: Settings → Webhooks in the repository or organization. Content type application/json; events: Deployment statuses, Workflow runs, Releases, and Pushes. Use the same secret as on the connection page.
- **Prometheus and Grafana:** the URL, plus a bearer or basic-auth credential if the instance is not public. For Grafana, a Viewer service account token.
