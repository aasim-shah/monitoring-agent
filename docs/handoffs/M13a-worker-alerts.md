# Handoff — M13a Probe job and website alerts

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-23 |
| **Branch** | `feat/m13a-websites` |
| **Plan** | M13a plan Task 3 |
| **Workbooks** | WB-09 UC-09-01/03, TC-09-01/02/03 |

## Delivered

- **The worker's `website-probe` job** (`apps/worker/src/website-handler.ts`):
  - **A pending monitor:**
    - It only checks the TXT record `pcp-verify=<token>` and is never probed.
    - Once verified, it becomes active and is probed straight away.
    - After 24 h unverified, it is paused.
  - **An active monitor:**
    - It is re-verified every 30 days. If the record is gone, it pauses with a reason naming the record and the domains checked.
    - Otherwise it is probed, and the last result is stored on the row: up, status, error, total ms, consecutive failures, and TLS expiry and issuer.
  - **Samples** go to `VM_IMPORT_URL`: `website_up`, `website_status_code`, `website_response_seconds`, `website_ttfb_seconds`, `website_redirects`, and `website_tls_expiry_days`, labelled with `tenant_id`, `product_id`, and `monitor_id`. A probe that did not run writes nothing.
  - **SSRF:** probes go to public addresses only. `PCP_PROBE_ALLOWLIST` (`host:port` entries) exists for test stacks.
- **Alert templates** (worker-evaluated in the alert tick, from the monitor rows; both are in the recommended set):

  | Template | Fires when | Severity |
  |---|---|---|
  | `website_down` | consecutive failures ≥ 2 | critical |
  | `website_tls_expiring` | the certificate expires in under 14 days | warning |

  - Only active monitors fire. A paused or unverified monitor resolves anything open.
  - Titles read "Website down on shop.example.com" and "TLS certificate expiring on …".
- **Compose:** the worker gets `VM_IMPORT_URL=http://victoriametrics:8428`, and the e2e override allowlists `web:3001`.

## Tests

- **Worker** (`website-handler.int.test.ts`, 6):
  - TC-09-01: an unverified domain is not probed and nothing is written
  - a TXT record leads to an active monitor, a probe, and labelled samples
  - TC-09-03: two failures, then a reset on recovery
  - the 24 h timeout pauses the monitor
  - a failed 30-day re-verification pauses it
  - a deleted monitor is skipped
  - plus the config test
- **Alerting:**
  - the tick opens "down" only on the 2nd failure and resolves on recovery
  - TC-09-02: a 13-day certificate gives a warning
  - unverified monitors never fire
  - the templates are recommended
- **Compose:** 6 tests.
