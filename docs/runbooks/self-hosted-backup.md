# Runbook — Self-hosted backup and restore

What the platform needs to come back after losing the server:

| Item | Where | How |
|---|---|---|
| PostgreSQL (accounts, configuration, incidents, reports, audit) | volume `pg-data` | nightly `pg_dump` (below) |
| `.env` with `MASTER_KEY` | `/opt/pcp/.env` | copied next to each dump; also keep a copy in your password manager |
| Agent root key | offline (`pki/root.key`) | never on the server; needed only to issue a new intermediate |
| Metrics (VictoriaMetrics), logs (VictoriaLogs), rollups | volumes `vm-data`, `vlogs-data`, `vm-longterm-data` | optional: `vmbackup` to S3-compatible storage; losing them loses history, not configuration |

Without `MASTER_KEY` a restored database cannot decrypt connection credentials or MFA secrets.

## Nightly backups

Install the timers once (they are in the repository):

```bash
cp infrastructure/systemd/pcp-backup.* infrastructure/systemd/pcp-watchdog.* /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now pcp-backup.timer pcp-watchdog.timer
```

Details, retention (14 days), and the restore drill: [backup-restore.md](backup-restore.md). Copy `/opt/pcp/backups/nightly` off the server daily (for example `rclone sync` to object storage): a backup on the same disk does not survive the disk.

## Restore into the running stack

```bash
cd /opt/pcp
docker compose stop api worker web ingest-gateway installer-runner
docker compose exec -T postgres dropdb -U postgres --if-exists pcp
docker compose exec -T postgres createdb -U postgres pcp
docker compose exec -T postgres pg_restore -U postgres -d pcp --no-owner < backups/nightly/pcp-<time>.dump
cp backups/nightly/env-<time> .env && chmod 600 .env    # the MASTER_KEY that encrypted this dump
docker compose up -d --wait
```

Check: sign in, open a connection's page (its credentials decrypt), and an agent heartbeats within a minute.

## Restore drill

Monthly, without touching the running database: `infrastructure/scripts/restore-drill.sh <dump>` (see [backup-restore.md](backup-restore.md)).
