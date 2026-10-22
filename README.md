# Product Control Plane

Multi-tenant AI Product Operations Control Plane. It connects to a customer's existing product ecosystem, builds an evidence-backed product knowledge graph, monitors infrastructure and business signals, investigates incidents with AI over verified evidence, and runs tightly controlled actions.

## Documents

| Document | Purpose |
|---|---|
| [AI_Product_Control_Plane_Architecture_and_Flows.md](AI_Product_Control_Plane_Architecture_and_Flows.md) | Architecture spec (authoritative) |
| [inital.md](inital.md) | Original requirements |
| [docs/superpowers/plans/2026-10-21-ai-product-control-plane.md](docs/superpowers/plans/2026-10-21-ai-product-control-plane.md) | Master development plan |
| [docs/workbooks/](docs/workbooks/README.md) | Feature workbooks: use cases, flows, tests |
| [docs/handoffs/](docs/handoffs/README.md) | Task handoffs and status board |
| [docs/adr/](docs/adr/) | Architecture decision records |

## Requirements

- Node.js 22 or newer (`.nvmrc`)
- pnpm 9.15.9 through corepack: run `corepack enable` once so `pnpm` is on `PATH` (Turborepo needs the `pnpm` binary)
- Docker with Compose v2
- Go 1.23 (optional locally; `scripts/go.sh` runs Go in Docker)

## Common commands

```bash
pnpm install          # install dependencies
pnpm build            # build all packages and apps
pnpm lint             # lint
pnpm typecheck        # type-check
pnpm test             # unit tests (all packages)
pnpm test:repo        # repository checks (ADRs, threat model, OpenAPI, CI)
```

## Run the stack locally

```bash
cp .env.example .env
# Fill in the secrets block: hex passwords (openssl rand -hex 32) and MASTER_KEY (openssl rand -base64 32)
docker compose up -d --build --wait
curl http://localhost:8080/healthz
```

Sign-up emails need `SMTP_URL` (for example a local Mailpit at `smtp://mailpit:1025`); without it no mail is sent.

## Add servers locally (agents)

Agent enrollment needs an agent PKI and HTTPS for `agent.localhost`:

```bash
pnpm --filter @pcp/api agent:pki --out ./.pki      # prints AGENT_CA_CERT, AGENT_CA_KEY, AGENT_CA_CHAIN, TASK_SIGNING_KEY
# Add those four lines to .env, plus:
#   CADDY_CONFIG=Caddyfile.local
#   AGENT_CA_DIR=./.pki
#   AGENT_CONTROL_URL=https://agent.localhost:8443
#   AGENT_INGEST_URL=https://ingest.localhost:8443
#   AGENT_OPAMP_URL=wss://agent.localhost:8443/agent/v1/opamp
docker compose up -d --build --wait
```

In the dashboard open a product → **Add your servers** → **Add server**, copy the token from the install command, then attach a demo agent that connects through Caddy's mTLS edge:

```bash
scripts/dev-host.sh <token> demo-host-1        # Ubuntu + systemd, real install.sh: agent and metrics
scripts/dev-agent.sh <token> demo-vps-1        # control channel only (no collector)
```

`dev-host.sh` gives a server that appears under **Infrastructure** with CPU, memory, and network charts (disk usage is only reported on real hosts).

For real VPS hosts, deploy the platform on a public domain: see `docs/runbooks/deploy-control-plane.md`. `pnpm test:agent-e2e` runs the whole agent flow against a fresh stack.

## Repository layout

See master plan §5. `apps/` holds deployable services, `packages/` shared libraries and connectors, `agents/` customer-side agents, `infrastructure/` Compose, Caddy, and telemetry configuration, `tests/` cross-service suites.
