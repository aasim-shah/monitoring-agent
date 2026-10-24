#!/usr/bin/env bash
# Independent platform watchdog (M19.5, spec §11.13). Runs on the Docker host from a systemd timer,
# outside the platform: if the API, worker, or VictoriaMetrics are down, the platform cannot alert
# about itself. One mail when a check starts failing, one when it recovers.
#
# WATCHDOG_CHECKS: file of name=shell-command lines (exit 0 = healthy).
# WATCHDOG_MAILER: command called as `mailer "<subject>"` with the body on stdin.
set -uo pipefail

STATE="${WATCHDOG_STATE:-/opt/pcp/watchdog}"
CHECKS="${WATCHDOG_CHECKS:-/opt/pcp/infrastructure/monitoring/checks}"
MAILER="${WATCHDOG_MAILER:-/opt/pcp/infrastructure/monitoring/smtp-mail.sh}"
mkdir -p "$STATE"

# Each check gets 30 s (coreutils timeout on Linux hosts; absent on macOS dev machines).
limit=()
command -v timeout >/dev/null && limit=(timeout 30)

failed=0
while IFS='=' read -r name cmd; do
  [ -z "$name" ] && continue
  case "$name" in \#*) continue ;; esac
  flag="$STATE/$name.down"
  if out=$(${limit[@]+"${limit[@]}"} bash -c "$cmd" 2>&1); then
    if [ -f "$flag" ]; then
      since=$(cat "$flag")
      rm -f "$flag"
      printf 'Check %s is healthy again on %s (down since %s).\n' "$name" "$(hostname)" "$since" |
        "$MAILER" "[pcp watchdog] RECOVERED: $name" || echo "watchdog: mail failed for $name" >&2
    fi
  else
    failed=1
    if [ ! -f "$flag" ]; then
      date -u +%Y-%m-%dT%H:%M:%SZ >"$flag"
      printf 'Check %s failed on %s at %s.\n\nCommand: %s\nOutput (last lines):\n%s\n' \
        "$name" "$(hostname)" "$(cat "$flag")" "$cmd" "$(printf '%s' "$out" | tail -n 20)" |
        "$MAILER" "[pcp watchdog] DOWN: $name" || echo "watchdog: mail failed for $name" >&2
    fi
  fi
done <"$CHECKS"
exit "$failed"
