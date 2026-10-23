# Handoff — M16 pcp-helper and agent 0.3.0

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-24 |
| **Branch** | `feat/m16-actions` |
| **Plan** | M16 plan Task 3 |
| **Workbooks** | WB-16 UC-16-08, BR-16-04/05/09, TC-16-05/06/09; D20 |

## Delivered

- **`pcp-helper`** (`agents/host-agent-go/cmd/pcp-helper`) is an opt-in root daemon.
- **Socket:** `/run/pcp-helper/helper.sock` (0660, `root:pcp-agent`), one JSON task in and one result out.
- **Checks, in order:**
  1. the Ed25519 signature, against the root-owned `/etc/pcp-agent/task-signing.pub`; never the agent's state file (Review Focus #1)
  2. `type=action` and `capability=service_restart`
  3. not expired
  4. single use, kept in `/var/lib/pcp-helper/used-tasks` for 24 h across restarts
  5. a unit name pattern, and the unit listed in the customer-owned `/etc/pcp-agent/helper.yaml`, re-read on every task
- **Restart:** `systemctl restart -- <unit>` as argv. It waits up to 60 s for `active` and re-checks 3 s later.
- **Agent 0.3.0:** forwards `action` tasks to the socket unchanged, one at a time, and reports "pcp-helper is not installed…" when there is no helper.
  - New command `pcp-agentctl task-key`, which the installer uses.
- **Installer:**
  - `--enable-helper` installs the helper and its unit, writes the key file and an empty allowlist (never overwritten), and starts `pcp-helper`.
  - Later runs upgrade an installed helper; `--uninstall` removes it.
- **Release:** the tarball now holds `pcp-agentctl`, `pcp-otelcol`, and `pcp-helper`, and the version is 0.3.0.

## Tests

- **Go helper tests** (9):
  - a valid restart that is then verified
  - unsigned, tampered, and expired tasks
  - a replayed task, also after a restart
  - a unit not on the allowlist, and metacharacters
  - other task types and capabilities
  - a key from someone else
  - a unit that fails after the restart
  - the block-list allowlist format and a missing allowlist file
  - socket mode 0660 and a round trip
- **Agent forwarding:** 2 tests. All agent Go packages pass.
