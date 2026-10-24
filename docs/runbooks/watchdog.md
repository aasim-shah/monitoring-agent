# Runbook — Independent watchdog

The platform cannot alert about its own outage. `pcp-watchdog.timer` runs `infrastructure/monitoring/watchdog.sh` on the host every 2 minutes (spec §11.13, BR-17-06).

## Checks

The checks are listed in `infrastructure/monitoring/checks`, one `name=command` per line:

| Check | Healthy when |
|---|---|
| `api` | The API's `/readyz` answers inside its container (database and Redis reachable) |
| `worker` | The worker's `/readyz` answers (PostgreSQL and Redis reachable) |
| `victoriametrics` | `/health` answers |
| `public` | `https://monitor.aasimshah.com/healthz` answers through nginx and Caddy |
| `backup` | A nightly dump is newer than 26 hours |

## Mail

- A failing check sends one mail: `[pcp watchdog] DOWN: <check>`, with the command's last output lines.
- A recovery sends one mail: `[pcp watchdog] RECOVERED: <check>`.
- Mail goes straight to the SMTP server in `/opt/pcp/.env` (`SMTP_URL`, `MAIL_FROM`), STARTTLS required. It never goes through the platform's worker.
- The recipient is `WATCHDOG_TO` in `/opt/pcp/watchdog.env` (mode 600).
- State lives in `/opt/pcp/watchdog/<check>.down`. While that file exists the check is down, and no further mail is sent until it recovers.

## Operate

```bash
systemctl list-timers pcp-watchdog.timer
journalctl -u pcp-watchdog.service -n 20
ls /opt/pcp/watchdog/            # *.down = checks currently failing
/opt/pcp/infrastructure/monitoring/watchdog.sh; echo $?   # run now; 1 = something is down
```

To test mail delivery, run:

```bash
echo test | WATCHDOG_TO=you@example.com /opt/pcp/infrastructure/monitoring/smtp-mail.sh "[pcp watchdog] test"
```
