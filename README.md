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

## Repository layout

See master plan §5. `apps/` holds deployable services, `packages/` shared libraries and connectors, `agents/` customer-side agents, `infrastructure/` Compose, Caddy, and telemetry configuration, `tests/` cross-service suites.
