# Runbook — Self-hosted upgrade

Upgrades are forward-only database migrations plus new images. Plan 15 minutes; the dashboard is unavailable for under a minute while api restarts. Agents keep collecting and queue their writes (remote_write WAL) while the platform restarts.

## 1. Before

```bash
cd /opt/pcp
git fetch --tags && git log --oneline HEAD..origin/main | head -50   # what changes
/opt/pcp/infrastructure/scripts/backup.sh                            # a fresh, verified dump
cp .env backups/env-pre-upgrade-$(date -u +%Y%m%d).bak && chmod 600 backups/env-pre-upgrade-*.bak
docker images --format '{{.Repository}} {{.ID}}' | grep '^pcp-' > backups/images-pre-upgrade.txt
```

Read the release notes for new settings (they are added to `.env.example`). Missing required settings stop the service at start with a message that names them.

## 2. Upgrade

```bash
git checkout <release tag>
docker compose build                      # or pull the release images
docker compose up -d --wait               # migrate runs first; api waits for it
docker compose ps
curl -fsS https://<app domain>/healthz
```

Add `--profile logs` and/or `--profile rollups` to `up` when you run those services.

## 3. After

- Sign in and open one product's **Overview** and one host's charts.
- `docker compose logs migrate | tail -3` should end with `roles bootstrapped and migrations applied`.
- Agents: upgrades happen when you re-run the install command on a host (the identity is kept). The dashboard shows each agent's version; features that need a newer agent say so (for example data inspection needs 0.5.0).
- Remove superseded images by ID once the new version is healthy: `docker rmi <old ids from backups/images-pre-upgrade.txt>`.

## 4. Roll back

Migrations are forward-only. To roll back, restore the pre-upgrade dump and the previous images:

```bash
git checkout <previous tag>
docker compose stop api worker web ingest-gateway
# restore: see self-hosted-backup.md "Restore into the running stack"
docker compose up -d --wait
```
