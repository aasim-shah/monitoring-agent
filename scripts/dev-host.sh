#!/usr/bin/env bash
# Attach a realistic test server to the local dev stack: an Ubuntu 24.04 container with
# systemd, installed with the real install.sh (agent + metrics collector), on the stack's
# edge network. Use the token from the dashboard's "Add server" dialog.
# Usage: scripts/dev-host.sh <enrollment-token> [hostname] [compose-project]
# Remove it: scripts/dev-host.sh --remove [hostname]
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
if [ "${1:-}" = "--remove" ]; then
  docker rm -f "pcp-dev-host-${2:-demo-host-1}" >/dev/null && echo "removed pcp-dev-host-${2:-demo-host-1}"
  exit 0
fi
token="${1:?usage: scripts/dev-host.sh <enrollment-token> [hostname] [compose-project]}"
name="${2:-demo-host-1}"
project="${3:-pcp-dev}"
caddy="$(docker compose -p "$project" ps -q caddy)"
[ -n "$caddy" ] || { echo "stack $project is not running" >&2; exit 1; }
address="$(docker inspect -f "{{(index .NetworkSettings.Networks \"${project}_edge\").IPAddress}}" "$caddy")"
docker build -q -t pcp-systemd-ubuntu:24.04 -f "$root/tests/agent-e2e/systemd-ubuntu.Dockerfile" "$root/tests/agent-e2e" >/dev/null
docker rm -f "pcp-dev-host-$name" >/dev/null 2>&1 || true
docker run -d --name "pcp-dev-host-$name" --hostname "$name" --privileged --cgroupns=host \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw --network "${project}_edge" \
  --add-host "agent.localhost:$address" --add-host "ingest.localhost:$address" \
  pcp-systemd-ubuntu:24.04 >/dev/null
for _ in $(seq 1 30); do docker exec "pcp-dev-host-$name" systemctl list-units >/dev/null 2>&1 && break; sleep 1; done
mkdir -p "$root/.pki"
docker cp "$caddy:/data/caddy/pki/authorities/local/root.crt" "$root/.pki/caddy-root.crt"
docker cp "$root/.pki/caddy-root.crt" "pcp-dev-host-$name:/root/caddy-root.crt"
docker exec "pcp-dev-host-$name" bash -c "curl -fsSL http://$address/install.sh | bash -s -- \
  --token '$token' --control-url https://agent.localhost --download-url http://$address/downloads \
  --ca-file /root/caddy-root.crt --ingest-url https://ingest.localhost"
echo "Server $name is installed. Logs: docker exec pcp-dev-host-$name journalctl -u pcp-agent -f"
