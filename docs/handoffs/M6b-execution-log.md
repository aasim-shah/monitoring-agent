# Execution Log — M6b Service Discovery and Monitoring Packs

| | |
|---|---|
| **Plan** | `docs/superpowers/plans/2026-10-22-m6b-service-packs.md` |
| **Branch** | `feat/m6b-services` (stacked on `feat/m6-host-agent`) |
| **Executed** | 2026-10-22 → 2026-10-23, inline, test-first |
| **Deployed** | `https://monitor.aasimshah.com` (shared VPS, other sites unchanged) |

## Ledger

```text
# SDD ledger — plan: docs/superpowers/plans/2026-10-22-m6b-service-packs.md
Spec: spec §8.6, §8.8, §8.10; master plan M6.3, M11, D24; WB-11, WB-04; branch feat/m6b-services stacked on feat/m6-host-agent.
Pre-flight: T1 tables consumed by T3 — consistent; T2 inventory shape consumed by T3 API and T5 UI — consistent (agent-protocol schema); T3 config/ack contract consumed by T4 agent — consistent; T4 metric names consumed by T5 templates — verify against real receivers in T4.
Ruling: credentials sealed with ECIES (X25519 + HKDF-SHA256 + AES-256-GCM; payload eph_pub||nonce||ciphertext, info "pcp-pack-credentials-v1") instead of libsodium crypto_box_seal (D24) — WebCrypto and Go stdlib only; last Go-1.23-compatible x/crypto is v0.41 (old, scanner noise) and libsodium adds ~200 KB to the web bundle — cost if wrong: browsers without WebCrypto X25519 (pre-2024) cannot seal; swap construction behind one function.
Ruling: pack configuration travels on the mTLS control channel (GET /agent/v1/config + ack) until OpAMP (D13) lands — cost if wrong: one adapter when the supervisor arrives.
Task 1: complete (commits 2af1db4..1fcae75, tests: pnpm --filter @pcp/database test →    Duration  15.81s (transform 522ms, setup 0ms, import 2.61s, tests 53.53s, environment 0ms))
Task 2: Ruling: Scan takes `now time.Time` in addition to fsys — deterministic collectedAt in tests — cost if wrong: none.
Task 2: Ruling: `<pid>/status` (Uid) not read — nothing in the inventory uses the owner; fewer reads under /proc — cost if wrong: add one read later.
Task 2: Ruling: kafka counted as sensitive for exposed_service along with the databases/caches — an open broker is as risky as an open database — cost if wrong: a warning the user may dismiss.
Task 2: Ruling: race detector not run (alpine Go image has no cgo); client swap fixed with atomic.Pointer by inspection — cost if wrong: a remaining race found later.
Task 2: complete (commits 1fcae75..02a8916, tests: bash -c 'scripts/go.sh test ./agents/host-agent-go/... && pnpm --filter @pcp/agent-protocol test' →    Duration  998ms (transform 154ms, setup 0ms, import 952ms, tests 415ms, environment 1ms))
Task 3: Ruling: ciphertext cleared on failed acks as well as applied — the agent has opened it; keeping it would leave a decryptable copy at rest for no use — cost if wrong: user re-enters credentials after a failure.
Task 3: Ruling: ack settles only rows with policy_version <= acked version — a change made mid-apply would otherwise lose its ciphertext — cost if wrong: none.
Task 3: Ruling: POST /packs returns 201 (create) / 200 (update) instead of OpenAPI's 202 placeholder; 409 on revoked agent — cost if wrong: client status handling.
Task 3: Ruling: OpenAPI pack-proposals replaced by GET /agents/:id/inventory (plan name) — cost if wrong: one rename.
Task 3: complete (commits 02a8916..efae39f, tests: pnpm --filter @pcp/api test →    Duration  36.82s (transform 6.32s, setup 0ms, import 115.04s, tests 147.06s, environment 5ms))
Task 4: Ruling: separate internal/packs.Applier (not in collector/control) — testable apply/validate/rollback without the run loop — cost if wrong: none.
Task 4: Ruling: Heartbeat returns HeartbeatAck{Accepted, PolicyVersion} (signature change) — the agent must see the version — cost if wrong: none (internal API).
Task 4: Ruling: agent stores applied packs + opened credentials in packs.json (0600) — ciphertext is deleted after ack, and restarts must keep monitoring — cost if wrong: credentials at rest on the host, same exposure as collector.yaml.
Task 4: Ruling: per-pack isolation on validation failure (validate each alone, apply the passing ones) — one bad pack must not block the others — cost if wrong: a few extra validate runs.
Task 4: Ruling: kafka receiver type is kafka_metrics in v0.162.0 (kafkametrics deprecated) — verified against upstream metadata.yaml and real validate — cost if wrong: none.
Task 4: complete (commits efae39f..0221ae6, tests: env PCP_OTELCOL=/src/.superpowers/sdd/2026-10-22-m6b-service-packs/otelcol/pcp-otelcol scripts/go.sh test ./agents/host-agent-go/... → ok  	pcp.local/hostagent/internal/packs	(cached))
Task 5: Ruling: WebCrypto ECIES in lib/seal.ts instead of libsodium-wrappers (follows the Task 1 ruling) — cost if wrong: browsers without X25519 WebCrypto cannot seal.
Task 5: Ruling: resource_to_telemetry_conversion enabled + process command/command_line/path/owner/parent_pid disabled — per-process labels without leaking command-line secrets — cost if wrong: a few extra labels per series (host_name, os_type).
Task 5: Ruling: kafka lag and process CPU queried with {__name__=~"…(_ratio)?"} — the unit-1 gauge suffix is not verified for those packs — cost if wrong: none (both names match).
Task 5: Ruling: web vitest testTimeout 15 s — existing add-server-dialog test hit 5 s under more parallel jsdom workers; passes in 1 s alone — cost if wrong: slow tests hide longer.
Task 5: Ruling: fixed pre-existing flake (TOTP helper used wall clock; fleet test froze app clock) — test-clock.int.test.ts RED→GREEN — cost if wrong: none.
Task 5: complete (commits 0221ae6..2e1e9b6, tests: bash -c 'pnpm --filter @pcp/web test && pnpm --filter @pcp/api test' →    Duration  46.97s (transform 5.48s, setup 0ms, import 159.17s, tests 149.13s, environment 28ms))
Task 6: Ruling: agent-e2e hookTimeout 30 min — a cold build compiles the collector (6 new receivers) for amd64+arm64; the 15 min limit expired during compose build — cost if wrong: a hung build is noticed later.
Task 6: Ruling: production SMTP on smtp.resend.com:587 (STARTTLS) — the VPS blocks outbound 465 — cost if wrong: none.
Task 6: Ruling: fixed SMTP hang found during deploy (nodemailer 2 min default → 10 s connect/greeting/socket) — mailer.test.ts RED→GREEN — cost if wrong: none.
Task 6: Ruling: removed the 6 superseded pcp images on the VPS by explicit ID (no prune) after verification — disk reached 92% on a shared host — cost if wrong: rollback needs a rebuild + reload (~10 min); DB backup kept in /opt/pcp/backups.
Task 6: complete (commits 2e1e9b6..9ff7e8e, tests: turbo 59/59 (api 174, web 89, database 66); after the mailer fix: mail+identity 45; test:repo 51; go test + vet ok (incl. real-collector validation); smoke 15; Playwright 3; agent-e2e 3 (service metrics 104 s after enabling); production: Redis+PostgreSQL applied in 17 s, charts in 93 s, email delivered via Resend, Google sign-in redirects, all other VPS sites unchanged)
Final review: self-review (session policy: no subagents unless the user asks). Checked: ciphertext never returned (tests + prod audit rows); agent routes scope by certificate identity only; service metrics packId via Object.hasOwn on a fixed map; discovery sends comm only, never cmdline; packs.json/collector.yaml/candidate mode 0600; sealed vector shared by Go and WebCrypto.
Final: Ruling: collector validation messages are stored as pack status messages — receiver passwords are configopaque (printed as [REDACTED]) — cost if wrong: a credential fragment in a status message; revisit when packs gain free-form settings.
Final: minor (deferred): BR-11-06 drop-label transform is not in the compiled config yet (allowlist filter and batch are).
Final: minor (deferred): agents installed before M6b (e.g. the user's 188.166.219.42) need the install command re-run to get discovery and packs (installer upgrades in place).
Final: minor (deferred): verification mail is still sent inside the sign-up request (~2 s); move to the job queue with M12 notifications.
Final: minor (deferred): prod test data — orgs/accounts deploy-check-24a6ddf9@aasimshah.com, delivered@resend.dev (unverified), delivered+m6b@/m6b2@ (unverified), delivered+m6bcheck51269@resend.dev with org "M6b prod check" (agent revoked).
Final: minor (deferred): Kafka, MySQL, MongoDB, nginx, and Node.js chart templates follow upstream metadata; only Redis and PostgreSQL are verified with live services.
```

## Results

- **Exit gate.** On an Ubuntu 24.04 systemd host running Redis and PostgreSQL:
  1. The agent discovers both services on loopback.
  2. Enabling the packs (PostgreSQL credentials sealed in the browser) applies them.
  3. The Redis and PostgreSQL charts show real series 104 s after enabling (`pnpm test:agent-e2e`, 3 passed).
  4. The ciphertext is gone after the agent acknowledges.
- **Production.** A test host enrolled at `monitor.aasimshah.com`:
  - Packs applied in 17 s; charts had data after 93 s.
  - The host page shows "Services on this server" with the "Monitoring" status and the per-pack charts (browser check).
- **Email.** Production sends through Resend from `alerts@aasimshah.com` over port 587. A verification email to a Resend test inbox was delivered.
- **Google sign-in.** `/api/v1/auth/google/start` redirects to Google with the production client (Testing mode).

## How to resume

- **Existing agents.** Agents installed before M6b, such as `188.166.219.42`, need the install command re-run to get discovery and packs. The installer upgrades in place, so no re-enroll is needed.
- **Next.** Milestones that need no external accounts: M8 (private worker, databases), M9 (discovery graph), M11 (logs), M12 (alerts and notifications), M14 (AI on Gemini with Groq as fallback). M7 waits for the GitHub OAuth app. M13 is unblocked now that the Google client exists.
