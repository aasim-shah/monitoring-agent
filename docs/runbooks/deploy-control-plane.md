# Runbook — Deploy the control plane on your own VPS

Audience: an operator who wants real servers (VPS) to report to the Product Control Plane.
Result: the dashboard at `https://app.<domain>`, agents connecting to `https://agent.<domain>`, metrics to `https://ingest.<domain>`.

## 1. What you need

| Item | Notes |
|---|---|
| One Linux VPS for the platform | 4 vCPU, 8 GB RAM, 80 GB disk is a comfortable start (for example a Hetzner CX32). Docker Engine 27+ with the Compose plugin. |
| A domain you control | Three DNS names: `app.`, `agent.`, `ingest.` |
| Open ports on the platform VPS | 80 and 443 (TCP) from the internet. Nothing else. |
| SMTP (optional at first) | For verification and invitation emails; without it, use the bootstrap admin flow. |

Monitored servers need **no open ports**: the agent connects outbound to `agent.` and `ingest.` on 443.

## 2. DNS

Create A (and AAAA if you use IPv6) records pointing at the platform VPS:

```text
app.example.com     → <platform IP>
agent.example.com   → <platform IP>
ingest.example.com  → <platform IP>
```

Wait until `dig +short app.example.com` returns the IP.

## 3. Get the code and secrets

```bash
git clone https://github.com/aasim-shah/monitoring-agent.git /opt/pcp && cd /opt/pcp
cp .env.example .env
```

Fill the secrets block in `.env`:

```bash
for v in POSTGRES_SUPERUSER_PASSWORD PCP_MIGRATOR_PASSWORD PCP_APP_PASSWORD PCP_SCHEDULER_PASSWORD REDIS_PASSWORD INTERNAL_TOKEN; do
  sed -i "s|^$v=.*|$v=$(openssl rand -hex 32)|" .env
done
sed -i "s|^MASTER_KEY=.*|MASTER_KEY=$(openssl rand -base64 32)|" .env
```

## 4. Agent certificate authority

Generate the agent PKI **on a trusted machine** (it needs Node 22 and pnpm; your laptop is fine):

```bash
pnpm install && pnpm --filter @pcp/api agent:pki --out ./pki
```

- Copy the four printed lines (`AGENT_CA_CERT`, `AGENT_CA_KEY`, `AGENT_CA_CHAIN`, `TASK_SIGNING_KEY`) into the server's `.env`.
- Copy `pki/chain.pem` to the server at `/opt/pcp/agent-ca/chain.pem`.
- Keep `pki/root.key` **offline** (password manager or encrypted USB). It is only needed to issue a new intermediate.

## 5. Production settings in `.env`

```dotenv
DEPLOYMENT_MODE=self_hosted
BOOTSTRAP_MODE=off
CADDY_CONFIG=Caddyfile.production
APP_DOMAIN=app.example.com
AGENT_DOMAIN=agent.example.com
INGEST_DOMAIN=ingest.example.com
ACME_EMAIL=you@example.com
APP_ORIGIN=https://app.example.com
HTTP_PORT=80
HTTPS_PORT=443
AGENT_CA_DIR=./agent-ca
AGENT_CONTROL_URL=https://agent.example.com
AGENT_INGEST_URL=https://ingest.example.com
AGENT_OPAMP_URL=wss://agent.example.com/agent/v1/opamp
SMTP_URL=smtp://user:pass@smtp.example.com:587   # optional
MAIL_FROM=Product Control Plane <no-reply@example.com>
```

## 6. Start

```bash
docker compose up -d --build --wait
curl -fsS https://app.example.com/healthz
```

Caddy obtains Let's Encrypt certificates for the three names on first start (ports 80/443 must be reachable).

## 7. First admin and your product

1. Open `https://app.example.com/signup`, create your account, verify the email, sign in.
2. Create the organization and set up two-factor authentication (required for owners).
3. Create your product (for example getRestro) and an environment (`production`).

## 8. Add servers

On the product page → **Add your servers** → **Add server** → choose the environment and how many servers → copy the command, then run it on each VPS:

```bash
curl -fsSL https://app.example.com/install.sh | sudo bash -s -- \
  --token pcp_enr_… --control-url https://agent.example.com \
  --download-url https://app.example.com/downloads
```

The installer verifies the binaries' SHA-256 checksums, creates the unprivileged `pcp-agent` user, enrolls the host, and starts `pcp-agent.service`. Within about a minute the server shows **Connected** in the dialog, and **Infrastructure** shows CPU, memory, disk, and network.

Supported: Linux amd64/arm64 with systemd (Ubuntu 22.04/24.04, Debian 12, RHEL/Rocky/Alma 9).

## 9. Operate

| Task | Command |
|---|---|
| Agent status on a VPS | `sudo -u pcp-agent pcp-agentctl status --state-dir /var/lib/pcp-agent` |
| Agent logs | `journalctl -u pcp-agent -f` |
| Upgrade an agent | re-run the install command (keeps its identity) |
| Re-enroll a host | install command with a new token and `--force` |
| Remove an agent | `curl -fsSL https://app.example.com/install.sh \| sudo bash -s -- --uninstall`, then **Revoke** it in the dashboard |
| Upgrade the platform | `git pull && docker compose up -d --build --wait` |
| Back up | PostgreSQL volume `pg-data` (daily `pg_dump`) and `.env`; metrics in `vm-data` are re-creatable |

## 10. Troubleshooting

| Symptom | Check |
|---|---|
| Dialog warns "Remote servers cannot reach this control URL" | `AGENT_CONTROL_URL` still points at localhost/private IP; set the public `agent.` URL and restart |
| `invalid_enrollment_token` | Token used up, expired (1 h default), or revoked; create a new command |
| Agent Connected but no metrics | `journalctl -u pcp-agent` for collector errors; outbound 443 to `ingest.` blocked by a firewall |
| Clock-skew warning on the agent page | Enable NTP: `timedatectl set-ntp true` |
| Certificate errors from Caddy | DNS not pointing at the platform yet, or port 80 blocked (ACME HTTP challenge) |
