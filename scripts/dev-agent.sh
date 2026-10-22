#!/usr/bin/env bash
# Attach a demo agent to the local dev stack (CADDY_CONFIG=Caddyfile.local). It runs the real
# pcp-agentctl in a container on the stack's edge network, so it reaches Caddy's mTLS edge
# exactly as a VPS would reach agent.<your domain>.
# Usage: scripts/dev-agent.sh <enrollment-token> [server-name] [compose-project]
# Stop it: docker rm -f pcp-dev-agent-<server-name>
set -euo pipefail
token="${1:?usage: scripts/dev-agent.sh <enrollment-token> [server-name] [compose-project]}"
name="${2:-demo-vps-1}"
project="${3:-pcp-dev}"
root="$(cd "$(dirname "$0")/.." && pwd)"
caddy="$(docker compose -p "$project" ps -q caddy)"
[ -n "$caddy" ] || { echo "stack $project is not running" >&2; exit 1; }
mkdir -p "$root/.pki"
docker cp "$caddy:/data/caddy/pki/authorities/local/root.crt" "$root/.pki/caddy-root.crt"
address="$(docker inspect -f "{{(index .NetworkSettings.Networks \"${project}_edge\").IPAddress}}" "$caddy")"
docker rm -f "pcp-dev-agent-$name" >/dev/null 2>&1 || true
docker run -d --name "pcp-dev-agent-$name" --hostname "$name" --network "${project}_edge" \
  -v "$root":/src:ro -w /src -v pcp-go-mod:/go/pkg/mod -v pcp-go-build:/root/.cache/go-build \
  -e GOFLAGS=-buildvcs=false -e GOTOOLCHAIN=local \
  golang:1.23.12-alpine sh -c "
    go build -o /usr/local/bin/pcp-agentctl ./agents/host-agent-go/cmd/pcp-agentctl &&
    pcp-agentctl enroll --token '$token' --control-url https://$address --server-name agent.localhost \
      --ca-file /src/.pki/caddy-root.crt --state-dir /var/lib/pcp-agent &&
    exec pcp-agentctl run --state-dir /var/lib/pcp-agent" >/dev/null
echo "Started pcp-dev-agent-$name; follow it with: docker logs -f pcp-dev-agent-$name"
