# Runbook — Self-hosted install

Audience: an operator running the Product Control Plane on their own infrastructure (spec Scenario D).
Base install: follow [deploy-control-plane.md](deploy-control-plane.md) first. This page adds the self-hosted options and the checks that prove the install is healthy.

## 1. Sizing

| Profile | Platform VPS | Notes |
|---|---|---|
| Up to 50 hosts | 4 vCPU, 8 GB RAM, 80 GB disk | Default Compose stack |
| + retained logs | + 1 GB RAM, + disk for 7 days of logs | `logs` profile |
| + 13-month rollups | + 256 MB RAM, ~5 GB disk per 100 hosts per year | `rollups` profile |

Measured capacity of a reference machine is in [capacity.md](capacity.md). Size from your own load tests before you promise numbers to anyone.

## 2. Sign-in

| Option | Settings |
|---|---|
| Email and password with MFA | Default; needs `SMTP_URL` for verification and invitations |
| Your OpenID Provider | `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI`, optional `OIDC_DISPLAY_NAME` |
| Google | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` |

At your OpenID Provider:

1. Create a confidential client with the authorization code flow.
2. Set the redirect URI `https://<app domain>/api/v1/auth/oidc/callback`.
3. Use the scopes `openid email profile`.

The platform signs in only users whose email the provider marks verified. The login page shows "Continue with <OIDC_DISPLAY_NAME>" as soon as the API restarts; no rebuild is needed.

## 3. AI

| Option | Settings |
|---|---|
| Hosted providers | `AI_PROVIDER` (`gemini`, `groq`, `openrouter`, `openai`), `AI_MODEL`, and the provider key |
| Your own model | `AI_PROVIDER=local`, `AI_MODEL=<model the endpoint serves>`, `AI_LOCAL_BASE_URL=http://<host>:11434/v1` (Ollama) or your vLLM URL; `AI_LOCAL_API_KEY` if the endpoint needs one |
| No AI | `AI_DISABLED=1`: the assistant answers "AI is turned off on this platform"; reports go out without a narrative |

Organizations can also turn AI off for themselves in Settings. Raw logs and inspection values never reach any model (BR-12-05, BR-12-07).

## 4. Optional services

| Service | Start | Settings |
|---|---|---|
| Retained logs (VictoriaLogs, 7 days) | `docker compose --profile logs up -d --wait` | `VLOGS_URL=http://victorialogs:9428` for api and ingest-gateway |
| 13-month rollups | `docker compose --profile rollups up -d --wait` | `VM_LONGTERM_URL=http://victoriametrics-longterm:8428`, `ROLLUPS_SINCE=<UTC timestamp of the start>` |
| Assisted SSH install | always defined (`installer-runner`, 32 MB) | `INSTALLER_EGRESS_IPS=<your public IP>`; customers allowlist it temporarily |

Restart api and ingest-gateway after you change these settings (`docker compose up -d --wait api ingest-gateway`).

## 5. Verify the install

```bash
docker compose ps                         # every service healthy
curl -fsS https://<app domain>/healthz    # {"status":"ok"}
curl -fsS https://<app domain>/install.sh | head -3
curl -fsS https://<app domain>/downloads/VERSION
```

Then:
1. Sign up (or sign in with OIDC) and create the organization and a product.
2. Add one server with the one-liner; it shows **Connected** within a minute and charts within two.
3. Create a website monitor and an alert rule. Send a test notification.
4. Create a daily report schedule and open **Send now**.

The Compose smoke suite (`pnpm test:smoke`) runs the same checks against a fresh stack on a development machine.

## 6. What to back up

See [self-hosted-backup.md](self-hosted-backup.md). The `.env` file (with `MASTER_KEY`) and the offline agent root key are as important as the database.
