# Handoff — M12 Compose and deployment wiring

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-23 |
| **Branch** | `feat/m12-alerts` |
| **Plan** | M12 plan Task 6 |

## Delivered

- **`compose.yaml`:**
  - **vmalert:**
    - Platform rules are read from `/etc/vmalert/rules`. Tenant rules are read from `/etc/vmalert/tenants`, the `alert-rules` volume mounted read-only.
    - Flags: `-configCheckInterval=1m`, `-notifier.url=http://api:3000/internal/alertmanager`, `-notifier.headers=X-Internal-Token:${INTERNAL_TOKEN}`, and `-external.url`.
    - Blackhole mode is removed.
  - **api:** mounts `alert-rules:/var/lib/pcp/alert-rules` read-write, with `ALERT_RULES_DIR` and `VMALERT_URL=http://vmalert:8880`. The api image creates that directory owned by `node`, so a new volume is writable.
  - **worker:** `SMTP_URL`, `MAIL_FROM`, and `APP_ORIGIN` for notifications.
- **`deploy/vps/compose.vps.yaml`:** vmalert is capped at 64 MB and added to the started services. The runbook was updated to match.
- **Checked by hand:**
  - vmalert v1.126.0 starts with an empty tenant directory.
  - The merged VPS config resolves.

## Tests

`scripts/__tests__/compose.test.mjs` (4 tests) checks:
- the notifier URL and token header, with no blackhole
- the shared volume (written by the api, read-only for vmalert)
- the worker's mail settings
- the VPS vmalert memory cap
