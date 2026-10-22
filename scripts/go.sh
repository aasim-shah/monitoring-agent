#!/usr/bin/env bash
# Run the Go toolchain. Uses a local `go` when installed, otherwise the pinned
# golang image in Docker with the repository mounted at /src.
# Usage: scripts/go.sh <go args...>      e.g. scripts/go.sh test ./apps/...
#        scripts/go.sh gofmt -l .        runs gofmt instead of go
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
tool=go
if [ "${1:-}" = "gofmt" ]; then tool=gofmt; shift; fi
# GO_DOCKER_NETWORK attaches the container to a Compose network (agent end-to-end test);
# PCP_* variables are passed through to the tests.
if [ -z "${GO_DOCKER_NETWORK:-}" ] && command -v "$tool" >/dev/null 2>&1; then
  cd "$root" && exec "$tool" "$@"
fi
extra=()
if [ -n "${GO_DOCKER_NETWORK:-}" ]; then extra+=(--network "$GO_DOCKER_NETWORK"); fi
while IFS='=' read -r name _; do
  case "$name" in PCP_*) extra+=(-e "$name") ;; esac
done < <(env)
exec docker run --rm ${extra[@]+"${extra[@]}"} -v "$root":/src -w /src \
  -v pcp-go-mod:/go/pkg/mod -v pcp-go-build:/root/.cache/go-build \
  -e GOFLAGS=-buildvcs=false -e GOTOOLCHAIN=local \
  golang:1.23.12-alpine "$tool" "$@"
