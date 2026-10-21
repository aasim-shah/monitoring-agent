# WB-17 · Platform Operations: Deployment, Self-Hosting, Backups, Security

| | |
|---|---|
| **Milestones** | M1, M19 (and release practices in plan §6.3) |
| **Spec** | §3, §11.13, §14.4, §17, §18, §19, §20 Scenario D |
| **Plan decisions** | D1, D2, D11; §3 retention |
| **Owners** | DevSecOps, Tech lead |

## 1. Purpose and scope

Running the platform itself: managed SaaS deployment, self-hosted installs, bootstrap, upgrades, backups and restore, key management, platform self-monitoring, retention, tenant data export and deletion, release of agent artifacts, and security hardening.

## 2. Actors

Platform operator (vendor SRE), enterprise operator (self-hosted customer), security reviewer, release engineer.

## 3. Use cases

| ID | Use case | Outcome |
|---|---|---|
| UC-17-01 | Deploy managed SaaS on a VPS | Compose stack healthy behind Caddy with TLS |
| UC-17-02 | Install self-hosted | Same images with `DEPLOYMENT_MODE=self_hosted` |
| UC-17-03 | Bootstrap over private HTTP, then switch to HTTPS | First admin created; enrollment/OAuth/webhooks enabled only after HTTPS |
| UC-17-04 | Upgrade the platform | Migrations run by one-shot `migrate`; services roll forward |
| UC-17-05 | Nightly backup | `pg_dump`, `vmbackup`, report artifacts to S3-compatible storage |
| UC-17-06 | Restore drill | Clean VPS restored and verified |
| UC-17-07 | Rotate keys | `MASTER_KEY`, `TASK_SIGNING_KEY`, agent CA intermediate rotated without downtime |
| UC-17-08 | Receive a platform self-monitoring alert | Operators alerted through an independent channel |
| UC-17-09 | Export or delete tenant data | Export bundle; deletion with grace period and purge |
| UC-17-10 | Run security scans and pentest | No open critical/high findings |
| UC-17-11 | Configure retention policies | Per data class within plan limits |
| UC-17-12 | Release agent artifacts | Signed packages, SBOM, versioned installer |
| UC-17-13 | Configure a local LLM or disable AI (self-hosted) | AI runs on customer endpoint or is off |

## 4. Flows

### UC-17-01 / UC-17-02: Deploy

1. Provision Ubuntu 24.04 VPS; open only 80/443.
2. Clone release bundle; copy `.env.example` to `.env`; set domain, `DEPLOYMENT_MODE`, `MASTER_KEY`, `TASK_SIGNING_KEY`, `AGENT_CA_KEY` and chain, SMTP, OIDC (self-hosted), AI provider.
3. `docker compose pull && docker compose up -d`.
4. `migrate` runs `prisma migrate deploy`, then `api`, `worker`, `web` start.
5. Caddy obtains certificates for `app.`, `agent.`, `ingest.`, `downloads.`.
6. Smoke check: all services healthy; storage ports not reachable from the host network.

### UC-17-03: Private HTTP bootstrap

1. `BOOTSTRAP_MODE=private_http` binds HTTP to a private interface.
2. Operator creates the first admin.
3. Agent enrollment, OAuth, and webhooks return 503 "HTTPS required".
4. Operator configures domain/TLS, unsets bootstrap mode, restarts Caddy.

### UC-17-04: Upgrade

1. Read release notes (breaking changes, migration duration).
2. Take a backup (UC-17-05).
3. Update image digests in `compose.yaml`; `docker compose pull`.
4. `docker compose up -d` → `migrate` runs first; if it fails, services do not start and the documented rollback applies.
5. Verify smoke checks; agents continue throughout (they buffer during API restarts).

### UC-17-05 + UC-17-06: Backup and restore

| Item | Method | Frequency | Retention |
|---|---|---|---|
| PostgreSQL | `pg_dump` (custom format), encrypted | Nightly | 30 days |
| VictoriaMetrics | `vmbackup` to S3-compatible | Nightly (incremental) | 30 days |
| VictoriaLogs (retained logs) | Snapshot | Nightly | Per plan retention |
| Report artifacts | Object storage versioning | Continuous | 1 year |
| Keys (`MASTER_KEY`, signing keys, CA) | Offline, separate custody | On change | Permanent |

Restore drill (monthly): new VPS → restore PostgreSQL and VictoriaMetrics → supply keys → start stack → verify a known tenant's connections decrypt, schedules exist, agents reconnect.

### UC-17-07: Key rotation

| Key | Procedure |
|---|---|
| `MASTER_KEY` | Add new version, set active, background re-wrap, remove old (WB-02 UC-02-10) |
| `TASK_SIGNING_KEY` | Publish new public key to agents through OpAMP; sign with new key; keep old valid 24 h |
| Agent CA intermediate | Issue new intermediate from offline root; Caddy trusts both; agents get new-chain certs at next rotation; remove old after 30 days |

### UC-17-09: Tenant data export and deletion

1. Owner requests export → job builds an archive (configuration, assets, relationships, incidents, reports, audit log; no secrets) → download link valid 24 h.
2. Owner requests deletion → organization `pending_deletion` for 30 days (reversible) → agents revoked, connections disconnected, schedules stopped.
3. After 30 days → purge PostgreSQL rows, crypto-shred secrets, delete telemetry by `tenant_id` (VictoriaMetrics delete series API), delete reports; audit summary kept per legal requirement.

### UC-17-12: Agent release

GoReleaser builds amd64/arm64 tarballs and `.deb`/`.rpm`, signs with cosign, generates SBOM (syft), renders versioned `install.sh` with embedded SHA-256, publishes to `downloads.<domain>/agent/<version>/`.

## 5. Business rules

| ID | Rule |
|---|---|
| BR-17-01 | Only HTTPS is exposed publicly; PostgreSQL, Redis, VictoriaMetrics, VictoriaLogs, vmalert stay private. |
| BR-17-02 | No secrets in images or committed env files. |
| BR-17-03 | Encrypted backups are useless without external keys; keys are backed up separately. |
| BR-17-04 | Restore drills run monthly and are documented. |
| BR-17-05 | No numeric SLOs are advertised before baselines exist. |
| BR-17-06 | Platform self-monitoring is separate from tenant telemetry. |
| BR-17-07 | Release images are pinned by digest. |
| BR-17-08 | Self-hosted: all operational records stay in customer infrastructure except data explicitly sent to authorized external services. |

## 6. Screens

Settings → Data retention, Security, AI providers; Organization → Export data, Delete organization (Owner only, typed confirmation).

## 7. Edge cases

| Case | Expected behavior |
|---|---|
| `MASTER_KEY` lost | Secrets unrecoverable; connections must be re-authorized; documented in runbook |
| Migration fails halfway | Transactional migrations roll back; services stay on old version |
| Disk full on control-plane VPS | Self-monitoring alerts at 80%; VictoriaMetrics retention enforced |
| Caddy cannot obtain TLS | Stack stays in bootstrap mode; clear error in logs |

## 8. Test cases

| ID | Covers | Given / When / Then |
|---|---|---|
| TC-17-01 | BR-17-01 | Compose smoke: storage ports unreachable from host network |
| TC-17-02 | UC-17-03 | Bootstrap mode → enrollment returns 503 |
| TC-17-03 | UC-17-04 | Upgrade with failing migration leaves old version running |
| TC-17-04 | UC-17-06 | Restore drill: connections decrypt, schedules present, agents reconnect |
| TC-17-05 | UC-17-07 | Task-signing rotation: agents accept new key, old valid 24 h |
| TC-17-06 | UC-17-09 | Deletion after grace removes tenant rows and series; secrets undecryptable |
| TC-17-07 | UC-17-12 | Release artifacts verify with cosign; SBOM present |
| TC-17-08 | UC-17-08 | Stopping VictoriaMetrics alerts operators via independent channel |

## 9. Task checklist

- [ ] M1.3 Compose and Caddy
- [ ] M1.4 CI pipeline
- [ ] M19.1 Security hardening
- [ ] M19.2 Load tests
- [ ] M19.3 Backup and restore
- [ ] M19.4 Self-hosted packaging
- [ ] M19.5 Platform self-monitoring
- [ ] M19.6 Documentation
- [ ] M19.7 Pilot
- [ ] M19.8 Tenant data export and deletion

## 10. Acceptance criteria

1. Installs on a clean Linux VPS (inital.md acceptance 1).
2. Container restarts preserve configuration and schedules (pilot item 10).
3. Backups restore to a clean deployment (spec §24.1).
4. Self-hosted install passes Scenario D.

## 11. Open items

- Data residency and compliance requirements by market (spec open decision #10).
