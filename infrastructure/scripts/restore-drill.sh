#!/usr/bin/env bash
# Restore drill (M19.3): restores a dump into a throwaway, network-less PostgreSQL container
# and prints row counts. Never touches the running database.
set -euo pipefail

DUMP="${1:?usage: restore-drill.sh <dump file>}"
NAME="pcp-restore-drill-$$"
IMAGE="${PG_IMAGE:-postgres:17.6-alpine}"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --rm --name "$NAME" --network none --memory 256m \
  -e POSTGRES_PASSWORD=drill -e POSTGRES_DB=pcp "$IMAGE" >/dev/null
# The image starts a temporary server for initialization, then the real one: wait for the second.
for _ in $(seq 1 90); do
  [ "$(docker logs "$NAME" 2>&1 | grep -c 'ready to accept connections')" -ge 2 ] && break
  sleep 1
done
# Roles of the source cluster do not exist here; ownership and grants are not restored.
docker exec -i "$NAME" pg_restore -U postgres -d pcp --no-owner --no-privileges <"$DUMP"

for table in organizations users connections; do
  n=$(docker exec "$NAME" psql -U postgres -d pcp -tAc "SELECT count(*) FROM $table" 2>/dev/null || echo missing)
  echo "$table $n"
done
echo "restore drill ok: $(basename "$DUMP")"
