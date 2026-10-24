#!/usr/bin/env bash
# Nightly PostgreSQL backup for the platform (M19.3). Runs on the Docker host as root.
# A dump is kept only after `pg_restore --list` reads it back; a failed run deletes nothing.
# .env is copied too: it holds MASTER_KEY, without which stored credentials cannot be decrypted.
set -euo pipefail

PCP_DIR="${PCP_DIR:-/opt/pcp}"
PG_CONTAINER="${PG_CONTAINER:-pcp-postgres-1}"
KEEP_DAYS="${KEEP_DAYS:-14}"
MIN_FREE_MB="${MIN_FREE_MB:-1024}"
DEST="$PCP_DIR/backups/nightly"

umask 077
mkdir -p "$DEST"
chmod 700 "$DEST"

free_mb=$(df -Pm "$DEST" | awk 'NR==2 {print $4}')
if [ "$free_mb" -lt "$MIN_FREE_MB" ]; then
  echo "backup refused: not enough free disk (${free_mb} MB free, need ${MIN_FREE_MB} MB)" >&2
  exit 2
fi

ts=$(date -u +%Y%m%dT%H%M%SZ)
partial="$DEST/pcp-$ts.dump.partial"
trap 'rm -f "$partial"' EXIT

docker exec "$PG_CONTAINER" pg_dump -U postgres -Fc pcp >"$partial"
# Verify before keeping: a truncated or empty dump fails here.
docker exec -i "$PG_CONTAINER" pg_restore --list >/dev/null <"$partial"
mv "$partial" "$DEST/pcp-$ts.dump"
chmod 600 "$DEST/pcp-$ts.dump"
if [ -f "$PCP_DIR/.env" ]; then
  cp "$PCP_DIR/.env" "$DEST/env-$ts"
  chmod 600 "$DEST/env-$ts"
fi

# Retention only after a good backup exists.
find "$DEST" -maxdepth 1 -type f \( -name 'pcp-*.dump' -o -name 'env-*' \) -mtime +"$KEEP_DAYS" -delete
echo "backup ok: pcp-$ts.dump ($(du -h "$DEST/pcp-$ts.dump" | cut -f1))"
