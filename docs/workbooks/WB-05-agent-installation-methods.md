# WB-05 · Agent Installation Methods

| | |
|---|---|
| **Milestones** | M6.7 (installer), M17 (fleet tooling, assisted install) |
| **Spec** | §8.7, §8.11, §4.12, §17.2 |
| **Plan decisions** | D12, D20, D22; §3 enrollment |
| **Owners** | Platform (Go), DevSecOps |

## 1. Purpose and scope

Every supported way to get the agent onto a customer server, upgrade it, and remove it. The platform never stores root passwords and never keeps permanent SSH access.

## 2. Actors

| Actor | Role |
|---|---|
| Customer server admin | Runs installer, Ansible, or cloud-init; or authorizes assisted install |
| Admin | Creates tokens; starts assisted install sessions |
| Installer runner | Opt-in Go service performing assisted SSH installs |

## 3. Use cases

| ID | Use case | Credentials reach platform? | Availability |
|---|---|---|---|
| UC-05-01 | Install with one-liner | No | MVP |
| UC-05-02 | Fleet install with Ansible | No | MVP |
| UC-05-03 | Install on new servers with cloud-init | No | MVP |
| UC-05-04 | Install on a Docker host with the Compose profile | No | MVP |
| UC-05-05 | Assisted SSH install with ephemeral key | Ephemeral key, destroyed | Opt-in |
| UC-05-06 | Assisted SSH install with password (last resort) | Memory only, single use | Opt-in |
| UC-05-07 | Uninstall agent | No | MVP |
| UC-05-08 | Upgrade agent | No (OpAMP) | MVP |
| UC-05-09 | Verify installer integrity before running | No | MVP |
| UC-05-10 | Install with helper / pack installer enabled | No | MVP (flag) |
| UC-05-11 | Install via cloud remote-run (AWS SSM, GCP, Azure) | Scoped cloud role | Post-pilot |

## 4. Flows

### UC-05-01: One-liner

```bash
curl -fsSL https://downloads.<domain>/agent/<version>/install.sh | sudo bash -s -- \
  --token <TOKEN> --environment production --packs host
```

Installer steps:

1. Check prerequisites: Linux, systemd, supported OS (D22), amd64/arm64, outbound HTTPS to `agent.`, `ingest.`, `downloads.` (honors `HTTPS_PROXY`).
2. Download the agent package for the architecture; verify SHA-256 against the checksum embedded in the versioned script.
3. Create system user/group `pcp-agent`; directories `/etc/pcp-agent/` (0750), `/etc/pcp-agent/secrets/` (0700), `/var/lib/pcp-agent/` (0700).
4. Install binaries `pcp-agentctl`, `opampsupervisor`, `pcp-otelcol`; optional `pcp-helper` with `--enable-helper`.
5. Run `pcp-agentctl enroll --token … --control-url …` (WB-03 UC-03-02).
6. Install and start `pcp-agent.service` and `pcp-agent-rotate.timer`.
7. Print agent ID and "visible in dashboard"; exit non-zero with a clear message on any failure, leaving no half-installed state.

### UC-05-02: Ansible

```yaml
- hosts: production
  become: true
  roles:
    - role: pcp_agent
      pcp_agent_token: "{{ vault_pcp_fleet_token }}"
      pcp_agent_environment: production
      pcp_agent_packs: [host]
```

The role wraps the same installer and is idempotent: re-running on an enrolled host does nothing.

### UC-05-03: cloud-init

The dashboard renders a `user-data` snippet with the fleet token and packs. New servers enroll on first boot. Token expiry must cover the provisioning window (max 24 h).

### UC-05-04: Docker host

`infrastructure/install/compose-agent/compose.yaml` runs the agent as a container with documented read-only mounts (`/proc`, `/sys`, optional `/` as `/hostfs` for `hostmetrics` `root_path`). The Docker socket is not mounted; Docker metrics use a read-only socket proxy only when the Docker pack is enabled.

### UC-05-05: Assisted SSH install

```mermaid
sequenceDiagram
  participant AD as Admin
  participant API as Control API
  participant IR as Installer runner
  participant S as Customer server
  AD->>API: Start assisted install (hosts, environment, packs)
  API->>IR: Create session; generate one-time ed25519 key pair
  API-->>AD: Public key + temporary user command + egress IPs
  AD->>S: Add key to temporary pcp-install user with sudo
  AD->>API: "Key added"
  IR->>S: SSH connect (from fixed egress IP)
  IR-->>AD: Host key fingerprint
  AD->>API: Confirm fingerprint
  IR->>S: Run signed install script only (no shell)
  S-->>IR: Output (streamed to dashboard)
  IR->>S: Remove key and pcp-install user
  IR->>IR: Destroy private key; record session result
```

Rules: no command except the fixed install and cleanup script; up to 10 hosts in parallel; session expires after 1 h; every step audited.

### UC-05-06: Password mode (last resort)

Same as UC-05-05, but the admin enters a password. It is held in runner memory only, used once, never written to disk or logs, and the dashboard tells the admin to rotate it afterwards.

### UC-05-07: Uninstall

```bash
sudo bash install.sh --uninstall
```

Stops services, removes binaries, units, user, `/etc/pcp-agent`, `/var/lib/pcp-agent`. The Admin revokes the agent in the dashboard (or the uninstaller calls revoke while its certificate is still valid).

### UC-05-08: Upgrade

Through OpAMP (WB-03 UC-03-11). No SSH access is needed after installation.

### UC-05-09: Verify integrity

The dashboard shows the script's SHA-256 and the release's cosign signature details. Security-conscious customers download the script, compare the hash, read it, then run it.

## 5. Business rules

| ID | Rule |
|---|---|
| BR-05-01 | The platform never stores root passwords or SSH private keys after a session. |
| BR-05-02 | Assisted install runs only the signed install script and cleanup. |
| BR-05-03 | The host-key fingerprint must be confirmed by the admin before the runner proceeds. |
| BR-05-04 | The runner connects only from published fixed egress IPs. |
| BR-05-05 | `install_sessions` contains no column that can hold a credential. |
| BR-05-06 | Installers are idempotent and leave no half-installed state on failure. |
| BR-05-07 | Agent packages are signed; checksums are embedded in the versioned script. |
| BR-05-08 | `--enable-helper` and `--enable-pack-installer` are off by default. |

## 6. Data

`install_sessions` (host, port, fingerprint, status, script version, output reference, cleanup confirmation, initiator), `agent_enrollments`.

## 7. Endpoints

```http
POST   /api/v1/install-sessions
POST   /api/v1/install-sessions/:id/hosts/:hostId/confirm-fingerprint
GET    /api/v1/install-sessions/:id            (status + streamed output via SSE)
DELETE /api/v1/install-sessions/:id            (abort + cleanup)
```

## 8. Screens

Agents → Install (tabs: One-liner, Ansible, cloud-init, Docker, Assisted install), Assisted install wizard (hosts, key instructions, fingerprint confirmation, live output, cleanup status).

## 9. Edge cases

| Case | Expected behavior |
|---|---|
| Unsupported OS or no systemd | Installer exits with list of supported platforms |
| Outbound HTTPS blocked | Installer reports which hostname failed; documents firewall rules and `HTTPS_PROXY` |
| SELinux enforcing (RHEL family) | Package ships the required file contexts; installer verifies service starts |
| Agent already installed | Installer reports existing agent ID and exits unless `--force` |
| Token expired mid-fleet rollout | Remaining hosts fail with "token expired"; admin creates a new token |
| Assisted install: cleanup fails | Session marked `cleanup_failed`; dashboard shows the exact manual cleanup commands |
| Assisted install: host key changes between connect and confirm | Session aborted |

## 10. Security

- No inbound port is needed except during an assisted install, and only from fixed egress IPs, temporarily.
- Fleet tokens should be stored in the customer's secret store (Ansible Vault, cloud secret manager).

## 11. Test cases

| ID | Covers | Given / When / Then |
|---|---|---|
| TC-05-01 | UC-05-01 | Installer on Ubuntu 22.04/24.04, Debian 12, Rocky 9 → agent enrolled and metrics visible within 60 s |
| TC-05-02 | BR-05-07 | Tampered binary → checksum failure, nothing installed |
| TC-05-03 | BR-05-06 | Failure at enrollment → no service, user, or directories left behind |
| TC-05-04 | UC-05-02 | Ansible role on 3 containers enrolls 3 agents; second run changes nothing |
| TC-05-05 | UC-05-07 | Uninstall removes user, units, directories |
| TC-05-06 | BR-05-03 | Runner refuses to run before fingerprint confirmation |
| TC-05-07 | UC-05-05 | After session, `pcp-install` user and key are gone |
| TC-05-08 | BR-05-05 | Schema test: no credential-capable column in `install_sessions` |
| TC-05-09 | UC-05-06 | Password never appears in disk, logs, or database |
| TC-05-10 | No inbound | After install, `ss -ltn` shows no new non-loopback listener |

## 12. Task checklist

- [ ] M6.7 Installer and systemd units
- [ ] M17.1 Fleet install UX
- [ ] M17.2 Fleet tooling (Ansible, cloud-init, Compose profile)
- [ ] M17.3 Installer runner (assisted SSH)

## 13. Acceptance criteria

1. One-liner installs work on every D22 platform.
2. Ansible installs 3 hosts in CI.
3. Assisted install succeeds and cleans up in a container test, with no credentials persisted.

## 14. Open items

- Cloud remote-run (UC-05-11) and a Terraform module are post-pilot.
