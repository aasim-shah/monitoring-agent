# Runbook — Deploy on a shared VPS behind an existing nginx

Audience: an operator whose VPS already runs other apps, with an nginx container owning ports 80/443 and certbot issuing certificates (the `monitor.aasimshah.com` deployment uses this).
For a dedicated server, use [deploy-control-plane.md](deploy-control-plane.md) instead.

## Layout

```text
Internet ──443──▶ existing nginx ──▶ 172.17.0.1:18090 ──▶ platform Caddy :80 ──▶ web / api / downloads
         (TLS for monitor.<domain>, certbot)          (docker0 only, never public)

Agents ──8443──▶ platform Caddy (TLS + client certificate) ──▶ api /agent/v1/*  (agent.<domain>)
                                                          └─▶ ingest-gateway   (ingest.<domain>)
Let's Encrypt HTTP-01 for agent./ingest. ──80──▶ nginx ──▶ 172.17.0.1:18090 ──▶ Caddy
```

| Piece | Where |
|---|---|
| Platform files | `/opt/pcp` (`compose.yaml`, `deploy/vps/compose.vps.yaml`, `infrastructure/`, `.env` mode 600, `agent-ca/chain.pem`) |
| nginx site | one new file in the nginx `conf.d` (here `/opt/runmypharmacy/nginx/conf.d/pcp-monitor.conf`); nothing else changes |
| Dashboard certificate | existing certbot webroot flow (`certbot certonly --webroot -w /var/www/certbot -d monitor.<domain>`) |
| Agent/ingest certificates | issued by the platform's Caddy (stored in the `pcp_caddy-data` volume) |
| Public ports added | `8443/tcp` only |
| Memory | every platform container is capped (`compose.vps.yaml`), ~1.6 GB worst case, ~0.6 GB typical |
| Not started on small hosts | `worker`, `vmalert`, `opamp-server` (not needed for server monitoring yet) |

## DNS

Three A records to the VPS IP, for example `monitor`, `agent.monitor`, `ingest.monitor` under your domain.

## Install / upgrade

1. Build amd64 images on a workstation (the VPS does not build):
   ```bash
   DOCKER_DEFAULT_PLATFORM=linux/amd64 docker compose -p pcp --env-file <dummy.env> \
     -f compose.yaml -f deploy/vps/compose.vps.yaml build api web migrate downloads ingest-gateway
   docker save pcp-api pcp-web pcp-migrate pcp-downloads pcp-ingest-gateway | gzip | \
     ssh root@<vps> 'gunzip | docker load'
   ```
2. Copy `compose.yaml`, `deploy/vps/compose.vps.yaml`, `infrastructure/caddy`, `infrastructure/telemetry`, `.env`, `agent-ca/chain.pem` to `/opt/pcp`.
3. Start:
   ```bash
   cd /opt/pcp && docker compose -p pcp -f compose.yaml -f deploy/vps/compose.vps.yaml --env-file .env \
     up -d --no-build --wait caddy ingest-gateway mailpit
   ```
4. nginx: add the port-80 blocks, `nginx -t`, reload; issue the dashboard certificate; add the 443 block, `nginx -t`, reload.

## Operate

| Task | Command (in `/opt/pcp`) |
|---|---|
| Status | `docker compose -p pcp ps` |
| Logs | `docker compose -p pcp logs -f api` |
| Real email | `SMTP_URL=smtp://resend:<key>@smtp.resend.com:587` (STARTTLS; many VPS providers block outbound 465), `MAIL_FROM="Product Control Plane <alerts@<domain>>"` |
| Back up before an upgrade | `docker compose -p pcp exec -T postgres pg_dump -U postgres -Fc pcp > backups/pcp-$(date -u +%Y%m%dT%H%M%SZ).dump` |
| Read sign-up mail (until SMTP is set) | `ssh -L 18225:127.0.0.1:18225 root@<vps>`, then open http://localhost:18225 |
| Stop everything (other apps unaffected) | `docker compose -p pcp down` (add `-v` only to delete platform data) |
| Remove completely | `docker compose -p pcp down -v`, delete `/opt/pcp`, remove `pcp-monitor.conf`, `nginx -t`, reload, close 8443 |
