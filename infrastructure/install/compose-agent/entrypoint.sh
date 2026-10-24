#!/bin/sh
# Enroll once (identity in the pcp-agent volume), then run. PCP_TOKEN is not needed after enrollment.
set -eu
STATE=/var/lib/pcp-agent
if [ ! -f "$STATE/state.json" ]; then
  : "${PCP_TOKEN:?set PCP_TOKEN to enroll}" "${PCP_CONTROL_URL:?set PCP_CONTROL_URL}"
  set -- --token "$PCP_TOKEN" --control-url "$PCP_CONTROL_URL" --state-dir "$STATE"
  if [ -n "${PCP_CA_FILE:-}" ]; then set -- "$@" --ca-file "$PCP_CA_FILE"; fi
  pcp-agentctl enroll "$@"
fi
exec pcp-agentctl run --state-dir "$STATE"
