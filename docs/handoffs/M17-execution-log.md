# Execution Log — M17 Installation Methods

| | |
|---|---|
| **Plan** | `docs/superpowers/plans/2026-10-25-m17-install.md` |
| **Branch** | `feat/m17-install` (stacked on `feat/m15b-report-trends`) |
| **Executed** | 2026-10-25, inline, test-first. Final review was a self-review (no subagent). |
| **Deployed** | `https://monitor.aasimshah.com` (migration 0016; migrate, api, web, worker, downloads, installer-runner; other VPS sites unchanged) |

Delivered: fleet install tabs (one-liner, Ansible, cloud-init, Docker), the Ansible role, cloud-init template, and Compose agent profile under `/downloads/install/`, and opt-in assisted SSH install (installer-runner: in-memory keys and passwords, host-key confirmation, fixed install command, verified cleanup).

## Ledger

```text
# SDD ledger — plan: docs/superpowers/plans/2026-10-25-m17-install.md
Spec: spec §4.12, §8.11; master plan M17; WB-05; branch feat/m17-install stacked on feat/m15b-report-trends.
Pre-flight: Task 3 consumes Task 1 install params (controlUrl, downloadUrl) for the runner command; Task 2 harness (sshd in systemd image) is reused by Task 3 e2e — consistent.
Task 1: Ruling: the Playwright 'max_uses=3 enrolls 3 simulated agents' journey is an API integration test (enrollment.int 'a fleet token enrolls up to maxUses hosts') — simulated agents need no browser; the dialog tabs have web tests — cost if wrong: none.
Task 1: complete (commit 051e1d9, tests: api enrollment.int 10/10, web components/agents 17/17, api-client 4/4)
Task 2: Ruling: fleet and assisted e2e live in control.e2e.test.ts (not a new file) — reuses the stack and owner the file starts; a second file would start a second stack — cost if wrong: none.
Task 2: Ruling: the Compose profile is tested by building its image and running it with the same mounts on the e2e network (not network_mode host) — Docker Desktop's host network cannot reach the e2e bridge; the image, entrypoint, tarball check, and root_path are what the test pins — cost if wrong: a host-network issue on a real Docker host is not covered.
Task 2: Ruling: cloud-init is covered by the dashboard snippet test (web) and the template file; not booted in CI — cost if wrong: a cloud-init syntax issue on a real provider.
Task 3: Ruling: redaction (redact.go) was written with its test in one step, not watched RED — small pure function — cost if wrong: none seen; the e2e checks output has no token.
Task 3: Ruling: assisted install is its own dialog (not a fifth tab of Add server) — it creates its own session and token — cost if wrong: UI placement only.
Task 3: Ruling: progress is polled every 2 s instead of SSE (as M10) — cost if wrong: one SSE endpoint later.
Task 3: Ruling: the password is copied into a Go string for x/crypto's Password auth; Go strings cannot be wiped, so it stays in runner memory until GC — the byte slice is wiped at session end — cost if wrong: a memory dump of the runner during the session's lifetime could show it.
Task 2: complete (commit 7d6c8fc, tests: go agent all ok incl. TestHostRootSetsRootPath + TestFilesystemScraperSkipsPseudoAndContainerMounts; contrib 0.162.0 validate exit 0; agent-e2e fleet tooling 2/2)
Task 2: fixed: under /hostfs the filesystem scraper walked every container overlay and held the collector above its 100 MiB limit — TestFilesystemScraperSkipsPseudoAndContainerMounts RED→GREEN.
Task 3: complete (commits d7dd4c9..7d6c8fc, tests: go installer-runner 6/6 x5, database install-sessions 2/2 + rls/drift 126/126, api install-sessions 3/3 + agents 64/64, web assisted-install 4/4 + agents 21/21, agent-e2e assisted SSH install 2/2)
Task 4: fixed: the database package's test script regenerated the Prisma client while other packages' tests imported it — @pcp/database#test now depends on its own build (78d41e7).
Task 4: Ruling: service-metrics 'Redis charts' failed once under full-suite load and passed 3/3 alone — timing at the counter's edges, not M17 code — cost if wrong: a flaky test to tighten later.
Task 4: pipeline: build, lint, typecheck, repo, openapi, audit, go+vet, Playwright 11/11, agent-e2e 10/10; format fixed (78d41e7); smoke 30/30 on rerun (first run's migrate exit was not reproducible on a fresh database); turbo test 54/55 + api telemetry flake 6/6 alone.
Task 4: deployed 2026-10-25: migration 0016; migrate, api, web, worker, downloads, installer-runner (new, 32 MB cap, 1.6 MB used); INSTALLER_EGRESS_IPS=204.168.197.27; pre-m17 pg_dump; images by resumable rsync with matching sha256; old images removed by ID; 22 sites unchanged; /downloads/install/* 200; install-sessions refuses unauthenticated (401).
Final review: self-review (no subagent tool used).
Final: minor (deferred): password mode keeps a Go string copy of the password until GC during the session.
Final: minor (deferred): the Compose agent profile's network_mode host path is tested only via docker run on the e2e network.
Task 4: complete
```
