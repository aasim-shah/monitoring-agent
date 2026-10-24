#!/usr/bin/env bash
# Sends one mail through the SMTP server in /opt/pcp/.env (SMTP_URL, MAIL_FROM) to WATCHDOG_TO,
# with STARTTLS required. Subject is $1; the body comes on stdin. Never prints the credentials.
set -euo pipefail
ENV_FILE="${PCP_ENV_FILE:-/opt/pcp/.env}"
SMTP_URL=$(grep -E '^SMTP_URL=' "$ENV_FILE" | cut -d= -f2-)
MAIL_FROM=$(grep -E '^MAIL_FROM=' "$ENV_FILE" | cut -d= -f2- | sed -E 's/.*<([^>]+)>.*/\1/')
TO="${WATCHDOG_TO:?set WATCHDOG_TO in /opt/pcp/watchdog.env}"
# smtp://user:pass@host:port → credentials and server for curl.
rest="${SMTP_URL#*://}"
creds="${rest%@*}"
server="${rest##*@}"
user=$(printf '%b' "${creds%%:*}")
pass=$(printf '%b' "$(printf '%s' "${creds#*:}" | sed 's/%/\\x/g')")
body=$(cat)
printf 'From: %s\r\nTo: %s\r\nSubject: %s\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n%s\r\n' \
  "$MAIL_FROM" "$TO" "$1" "$body" |
  curl --silent --show-error --ssl-reqd --url "smtp://$server" \
    --user "$user:$pass" --mail-from "$MAIL_FROM" --mail-rcpt "$TO" --upload-file -
