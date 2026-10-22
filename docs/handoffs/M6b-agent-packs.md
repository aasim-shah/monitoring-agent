# Handoff — M6b agent applies monitoring packs

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-22 |
| **Branch** | `feat/m6b-services` |
| **Plan** | M6b plan Task 4 |
| **Workbooks** | WB-11 §5–§6, BR-11-03, BR-11-06, D24 |

## Delivered

- **Sealed credentials.** `control.OpenSealed(sealedB64, id)` uses ECIES:
  - X25519
  - HKDF-SHA256 with salt = ephemeral public key || recipient public key, and info `pcp-pack-credentials-v1`
  - AES-256-GCM
  - payload = ephemeral public key (32 bytes) || nonce (12 bytes) || ciphertext + tag
  - Only the Go standard library is used; HKDF is implemented inline because `crypto/hkdf` needs Go 1.24.
  - The shared vector `packages/agent-protocol/testdata/sealed-credentials.json` was sealed with WebCrypto, which is what the dashboard uses.
- **Collector config.** `collector.Config` accepts `Packs []PackConfig`. Each pack adds a receiver:
  - `redis`, `postgresql`, `mysql`, `mongodb`, `kafka_metrics`, `nginx`
  - for nodejs, `host_metrics/nodejs` with the `process` scraper
  - All collect every 30 s.
  - A `filter/allowlist` processor (OTTL `not IsMatch(name, "^(system|process|<packs>)[.]")`) runs right after `memory_limiter`; `batch` runs last.
- **`internal/packs.Applier`** (Review Focus #2):
  1. Opens sealed credentials.
  2. Reuses stored credentials when the control plane no longer sends them.
  3. Validates candidates with `pcp-otelcol validate`. When the full set fails, it validates each pack alone and applies the ones that pass.
  4. Writes `collector.yaml` and `packs.json` (mode 0600, atomic rename), then restarts the collector.
  5. A configuration the collector rejects never replaces the running one; rejected packs ack `failed` with the collector's message.
- **Supervisor.** It gains a `Restart` channel: the collector restarts at once, with no backoff.
- **Control client.**
  - `Heartbeat` now returns `HeartbeatAck{Accepted, PolicyVersion}`.
  - New methods: `Config`, `AckConfig`.
- **`pcp-agentctl run`.**
  - The heartbeat reports the applied version. When the control plane's version differs, the agent fetches the configuration, applies it, and acks.
  - A failed fetch or ack retries on the next heartbeat.
  - At start, the collector runs with the packs applied last time.
  - Without a collector binary, every pack acks `failed` with a message.
  - `enroll --force` deletes `packs.json`. `collector-config` prints the stored packs with credentials redacted.
- **Collector build** (`builder-config.yaml`): adds the redis, postgresql, mysql, mongodb, nginx, and kafkametrics receivers and `filterprocessor`, all v0.162.0.

## Notes for Task 5/6

- `pcp-otelcol validate` does not check every endpoint. For example, nginx `not a url` and mysql without a port pass validation. The API's settings validation is the first gate.
- Prometheus metric names after remote_write still need checking against real series in the Task 6 end-to-end run, before the chart templates are fixed.

## Tests

`scripts/go.sh test ./agents/host-agent-go/...` passes:
- sealed vector, wrong key, tampering, bad sizes
- pack receivers and allowlist
- applier: credentials kept across versions and forgotten on removal; partial and total validation failure; credentials that cannot be opened; unknown pack
- supervisor restart

With `PCP_OTELCOL` set to the built binary, `TestRealCollectorAcceptsEveryPack` validates all seven packs against the real collector and checks that a rejected redis endpoint carries the collector's `missing port` message.
