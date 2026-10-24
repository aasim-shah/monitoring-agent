# Runbook — Backups and restore

## What runs

- **`pcp-backup.timer`** runs `infrastructure/scripts/backup.sh` every night at 02:30 UTC, with up to 15 minutes of random delay.
  - It writes `pg_dump -Fc` to `/opt/pcp/backups/nightly/pcp-<UTC time>.dump`, mode 600.
  - It copies `/opt/pcp/.env` next to the dump (`env-<UTC time>`, mode 600). That file holds `MASTER_KEY`. Without the key, stored connection credentials and MFA secrets in a restored database cannot be decrypted (BR-17-03).
  - A dump is kept only after `pg_restore --list` reads it back.
  - A failed run leaves no file behind and deletes nothing.
  - Dumps and `.env` copies older than 14 days are removed, but only after a good backup exists.
  - If less than 1 GB of disk is free, the backup refuses to run and logs why.
- **The watchdog** checks `backup` every 2 minutes. It mails if no dump is newer than 26 hours. See [watchdog](watchdog.md).

## Check

```bash
systemctl list-timers pcp-backup.timer
journalctl -u pcp-backup.service -n 20
ls -la /opt/pcp/backups/nightly
```

## Restore drill (monthly, BR-17-04)

```bash
/opt/pcp/infrastructure/scripts/restore-drill.sh "$(ls -t /opt/pcp/backups/nightly/pcp-*.dump | head -1)"
```

- The drill restores into a throwaway PostgreSQL container with no network and 256 MB of memory.
- It prints row counts for organizations, users, and connections, then removes the container.
- It never touches the running database.
- Record the date and the counts in the execution log.

## Restore for real

1. Stop writers:

   ```bash
   cd /opt/pcp && docker compose -p pcp -f compose.yaml -f deploy/vps/compose.vps.yaml --env-file .env stop api worker web
   ```

2. Take a dump of the current state first, even if it is broken:

   ```bash
   /opt/pcp/infrastructure/scripts/backup.sh
   ```

3. Restore the chosen dump:

   ```bash
   docker exec -i pcp-postgres-1 pg_restore -U postgres -d pcp --clean --if-exists < /opt/pcp/backups/nightly/pcp-<time>.dump
   ```

4. Make sure `/opt/pcp/.env` has the `MASTER_KEY` from the matching `env-<time>` copy.
5. Start the services again:

   ```bash
   docker compose -p pcp -f compose.yaml -f deploy/vps/compose.vps.yaml --env-file .env up -d --no-build --wait caddy ingest-gateway mailpit worker vmalert
   ```

## Off-host copies

Backups live on the same disk as the database. A lost disk loses both. Copy `/opt/pcp/backups/nightly` off the host regularly, for example with `rsync` to another machine or an S3-compatible bucket. Keep the `.env` copies in a separate, access-controlled place.

VictoriaMetrics data (metrics) is not backed up. After a restore, metrics older than the restore point are kept, and the time between the restore point and the failure is lost.
