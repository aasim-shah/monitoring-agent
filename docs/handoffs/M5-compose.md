# Handoff — M5 Compose wiring, local TLS, docs

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-22 |
| **Branch** | `feat/m5-onboarding-agents` |
| **Plan** | M5 plan Task 10 |
| **Workbooks** | WB-03 §7, §12; WB-05 |

## Summary

The Compose stack runs agents end to end. Caddy has a fixed address on the edge network so the API can trust its certificate header, and a laptop TLS configuration makes the agent flow testable without a domain. The dashboard warns when an install command points at an address a remote server cannot reach.

## Delivered

| Piece | Change |
|---|---|
| `compose.yaml` | `edge` subnet `${EDGE_SUBNET:-172.30.0.0/24}`, Caddy at `${CADDY_ADDRESS}`; API gets `AGENT_PROXY_ADDRESSES` and the agent PKI variables (done in Task 4) |
| `infrastructure/caddy/Caddyfile.local` | `tls internal` for `agent.localhost` / `ingest.localhost` (Task 4) |
| `.env.example`, `README.md` | Agent variables, `EDGE_SUBNET` / `CADDY_ADDRESS`, "Add servers locally" walkthrough |
| `apps/api/scripts/agent-pki.mjs` | `--out` resolves against the caller's directory; builds its dependencies first |
| `scripts/dev-agent.sh` | Demo agent on a local stack |
| Smoke and e2e stacks | Own subnets and Mailpit port (18235) so they run beside a dev stack |
| `AddServerDialog` + `lib/reachability.ts` | Notice when `--control-url` is localhost, loopback, or private: remote servers cannot reach it |
| WB-03 | Routes and checklist updated |

## Tests

| Suite | Result |
|---|---|
| `pnpm test:smoke` (both modes; worker ready; compose config checks) | 14 passed |
| `pnpm test:e2e` (onboarding, navigation, agents journey with the real Go agent) | 3 passed |
| `pnpm test:agent-e2e` (Go client through Caddy mTLS) | 1 passed |
| Web (adds reachability and dialog warning) | 67 passed |

## Ruling

- The plan's extra smoke assertions for `Caddyfile.local` (401 without a client certificate, `invalid_enrollment_token`) are covered by `pnpm test:agent-e2e` and the Playwright agents journey, which run the whole flow through the same Caddy configuration; the bootstrap 503 check remains in smoke.
