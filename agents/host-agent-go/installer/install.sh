#!/usr/bin/env bash
# Product Control Plane agent installer (master plan M6.7, spec §8.7).
#
#   curl -fsSL https://app.example.com/install.sh | sudo bash -s -- \
#     --token <enrollment-token> --control-url https://agent.example.com \
#     --download-url https://app.example.com/downloads
#
# Installs pcp-agentctl and pcp-otelcol after verifying their SHA-256 checksums, creates the
# unprivileged pcp-agent user, enrolls this host, and starts the pcp-agent systemd service.
# The agent only makes outbound HTTPS connections; no port is opened on this host.
# Re-running upgrades the binaries and keeps the enrolled identity; --force re-enrolls.
#   --enable-helper  also install pcp-helper (opt-in, root): restarts only the systemd units you
#                    list in /etc/pcp-agent/helper.yaml, for signed and approved actions (D20)
#   --enable-pack-installer  also let pcp-helper install Level 1 exporters (redis_exporter,
#                    kafka_exporter) after an approved action: version-pinned, checksum-checked,
#                    own user and unit, 127.0.0.1 only (implies --enable-helper; spec §8.9)
#   --uninstall      stop the service and remove the agent, its user, and its data
set -euo pipefail

TOKEN="" CONTROL_URL="" DOWNLOAD_URL="" FORCE=0 UNINSTALL=0 CA_FILE="" SERVER_NAME="" INGEST_URL="" ENABLE_HELPER=0 PACK_INSTALLER=0
STATE_DIR=/var/lib/pcp-agent CONF_DIR=/etc/pcp-agent BIN_DIR=/usr/local/bin
UNIT=/etc/systemd/system/pcp-agent.service HELPER_UNIT=/etc/systemd/system/pcp-helper.service

die() { echo "pcp-agent install: $*" >&2; exit 1; }
say() { echo "pcp-agent install: $*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --token) TOKEN="${2:-}"; shift 2 ;;
    --control-url) CONTROL_URL="${2:-}"; shift 2 ;;
    --download-url) DOWNLOAD_URL="${2:-}"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --enable-helper) ENABLE_HELPER=1; shift ;;
    --enable-pack-installer) ENABLE_HELPER=1; PACK_INSTALLER=1; shift ;;
    # Development stacks only: private TLS root, TLS name when connecting by IP, ingest override.
    --ca-file) CA_FILE="${2:-}"; shift 2 ;;
    --server-name) SERVER_NAME="${2:-}"; shift 2 ;;
    --ingest-url) INGEST_URL="${2:-}"; shift 2 ;;
    *) die "unknown option $1" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "run as root (sudo)"
command -v systemctl >/dev/null || die "systemd is required"

if [ "$UNINSTALL" -eq 1 ]; then
  systemctl disable --now pcp-agent >/dev/null 2>&1 || true
  systemctl disable --now pcp-helper >/dev/null 2>&1 || true
  # Level 1 exporters the helper installed (M18.3): units, binaries, and their users.
  for u in /etc/systemd/system/pcp-exporter-*.service; do
    [ -e "$u" ] || continue
    systemctl disable --now "$(basename "$u")" >/dev/null 2>&1 || true
    rm -f "$u"
  done
  rm -rf /opt/pcp-exporters /etc/systemd/system/pcp-helper.service.d
  for user in $(getent passwd | cut -d: -f1 | grep '^pcp-exp-' || true); do userdel "$user" || true; done
  rm -f "$HELPER_UNIT" "$BIN_DIR/pcp-helper"
  rm -rf /var/lib/pcp-helper
  rm -f "$UNIT" "$BIN_DIR/pcp-agentctl" "$BIN_DIR/pcp-otelcol"
  systemctl daemon-reload
  rm -rf "$STATE_DIR" "$CONF_DIR"
  if id pcp-agent >/dev/null 2>&1; then userdel pcp-agent; fi
  say "removed"
  exit 0
fi

[ -n "$CONTROL_URL" ] || die "--control-url is required"
[ -n "$DOWNLOAD_URL" ] || die "--download-url is required"
DOWNLOAD_URL="${DOWNLOAD_URL%/}"
command -v curl >/dev/null || die "curl is required"
command -v sha256sum >/dev/null || die "sha256sum is required"

case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "unsupported architecture $(uname -m) (amd64 and arm64 are supported)" ;;
esac

WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT
curl -fsSL "$DOWNLOAD_URL/VERSION" -o "$WORK/VERSION" || die "cannot reach $DOWNLOAD_URL"
VERSION="$(tr -d '[:space:]' < "$WORK/VERSION")"
TARBALL="pcp-agent-$VERSION-linux-$ARCH.tar.gz"
curl -fsSL "$DOWNLOAD_URL/SHA256SUMS" -o "$WORK/SHA256SUMS"
curl -fsSL "$DOWNLOAD_URL/$TARBALL" -o "$WORK/$TARBALL"
(cd "$WORK" && grep " $TARBALL\$" SHA256SUMS | sha256sum -c --status -) \
  || die "checksum mismatch for $TARBALL; nothing was installed"
tar -xzf "$WORK/$TARBALL" -C "$WORK"
say "verified $TARBALL"

if ! id pcp-agent >/dev/null 2>&1; then
  useradd --system --no-create-home --home-dir "$STATE_DIR" --shell /usr/sbin/nologin pcp-agent
fi
# Read access to service logs for the live log viewer (files under /var/log are group adm on
# Debian/Ubuntu; the journal is systemd-journal). Read only; no other privilege.
for g in adm systemd-journal; do
  if getent group "$g" >/dev/null 2>&1; then usermod -aG "$g" pcp-agent; fi
done
install -d -m 0750 -o root -g pcp-agent "$CONF_DIR"
install -d -m 0700 -o pcp-agent -g pcp-agent "$STATE_DIR"
install -m 0755 "$WORK/pcp-agentctl" "$BIN_DIR/pcp-agentctl"
install -m 0755 "$WORK/pcp-otelcol" "$BIN_DIR/pcp-otelcol"
if [ -n "$CA_FILE" ]; then
  install -m 0644 "$CA_FILE" "$CONF_DIR/ca.pem"
  CA_FILE="$CONF_DIR/ca.pem"
fi

if [ -f "$STATE_DIR/state.json" ] && [ "$FORCE" -eq 0 ]; then
  say "already enrolled; upgraded binaries to $VERSION (use --force to re-enroll)"
else
  [ -n "$TOKEN" ] || die "--token is required to enroll"
  args=(enroll --token "$TOKEN" --control-url "$CONTROL_URL" --state-dir "$STATE_DIR")
  [ "$FORCE" -eq 1 ] && args+=(--force)
  [ -n "$CA_FILE" ] && args+=(--ca-file "$CA_FILE")
  [ -n "$SERVER_NAME" ] && args+=(--server-name "$SERVER_NAME")
  [ -n "$INGEST_URL" ] && args+=(--ingest-url "$INGEST_URL")
  runuser -u pcp-agent -- "$BIN_DIR/pcp-agentctl" "${args[@]}"
fi

cat > "$UNIT" <<'UNIT_EOF'
@@UNIT@@
UNIT_EOF
systemctl daemon-reload
systemctl enable pcp-agent >/dev/null 2>&1
systemctl restart pcp-agent
say "pcp-agent $VERSION is running; it appears in the dashboard within a minute"

# pcp-helper (opt-in): installed with --enable-helper, upgraded when already present.
if [ "$ENABLE_HELPER" -eq 1 ] || [ -f "$HELPER_UNIT" ]; then
  install -m 0755 "$WORK/pcp-helper" "$BIN_DIR/pcp-helper"
  # The helper trusts only this root-owned copy of the platform key, never the agent's state.
  "$BIN_DIR/pcp-agentctl" task-key --state-dir "$STATE_DIR" > "$WORK/task-signing.pub" \
    || die "cannot read the task-signing key; is this host enrolled?"
  install -m 0644 -o root -g root "$WORK/task-signing.pub" "$CONF_DIR/task-signing.pub"
  if [ ! -f "$CONF_DIR/helper.yaml" ]; then
    cat > "$CONF_DIR/helper.yaml" <<'ALLOW_EOF'
# pcp-helper allowlist: only these systemd units can be restarted, and only after an approved,
# signed action. You own this file; the platform cannot change it.
capabilities:
  service_restart:
    units: []
  pack_install:
    enabled: false
ALLOW_EOF
    chown root:root "$CONF_DIR/helper.yaml"
    chmod 0644 "$CONF_DIR/helper.yaml"
  fi
  if [ "$PACK_INSTALLER" -eq 1 ]; then
    # The owner opts in here; the helper reads it at execution time (BR-05-08).
    sed -i '/^  pack_install:/,/^  [a-z_]*:/ s/^    enabled: false/    enabled: true/' "$CONF_DIR/helper.yaml"
    grep -q '^    enabled: true' "$CONF_DIR/helper.yaml" || die "could not enable pack_install in $CONF_DIR/helper.yaml"
    # Installing an exporter writes its unit under /etc/systemd/system, its binary under
    # /opt/pcp-exporters, and its system user; /usr and /boot stay read-only.
    mkdir -p /etc/systemd/system/pcp-helper.service.d
    cat > /etc/systemd/system/pcp-helper.service.d/pack-installer.conf <<'DROPIN_EOF'
[Service]
ProtectSystem=true
DROPIN_EOF
  fi
  cat > "$HELPER_UNIT" <<'HELPER_UNIT_EOF'
@@HELPER_UNIT@@
HELPER_UNIT_EOF
  systemctl daemon-reload
  systemctl enable pcp-helper >/dev/null 2>&1
  systemctl restart pcp-helper
  say "pcp-helper is running; list the units it may restart in $CONF_DIR/helper.yaml"
fi
