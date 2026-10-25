# Getting started

Audience: a team setting up monitoring for one product (for example a SaaS with an API, a website, and a few servers). About 30 minutes.

## 1. Account and organization

1. Sign up (email, Google, or your company's single sign-on if your administrator set it up) and verify your email.
2. Create your organization and set your time zone; reports and quiet hours use it.
3. Owners must turn on two-factor authentication. Invite teammates from **Members** with the least role they need:

| Role | Can |
|---|---|
| Owner | everything, including approvals in production, export, and deletion |
| Admin | everything except approving production actions, exporting, and deleting the organization |
| Operator | add servers, enable packs, live-tail logs, run data inspection, propose actions, manage incidents and reports |
| Analyst | read everything and use the AI assistant |
| Viewer | read |

## 2. Product and environments

Create a **product** for each thing you ship, and environments such as `production` and `staging`. Policies (for example which actions need approval) are set per environment; `production` is always the strictest.

## 3. Servers

**Agents → Add server** gives you a one-time command, as a one-liner, an Ansible role, cloud-init user data, or a Docker Compose profile. The agent connects outbound over HTTPS only; no port is opened on your server. **Assisted install** can do it for you over SSH with a one-time key that it removes afterwards.

Within a minute the server shows CPU, memory, disk, and network. **Services on this server** lists what the agent found (Redis, PostgreSQL, nginx, Node.js, Kafka …); enable a pack to chart it. Packs that need a credential encrypt it in your browser for that server only.

Optional per pack:
- **Deep metrics** (Level 2): a guided change on your side (for example the OpenTelemetry SDK in a Node.js app) with a live check that it works.
- **Managed exporter** (Level 1): the platform installs a pinned exporter on 127.0.0.1 after an approved action (needs `--enable-pack-installer` on that server).
- **Keep logs for 7 days**: redacted on your server before they leave it.
- **Data inspection** (Redis, Kafka): statistics only, never values; an owner or admin turns it on per pack.

## 4. Websites, integrations, and Google

- **Websites**: add a URL; after you prove the domain with a DNS TXT record the platform checks it every minute from outside and watches its TLS certificate.
- **Integrations**: GitHub (deployments), Cloudflare, Prometheus, Grafana, and databases (read-only users; databases inside your network go through the private connector worker). Each asks only for the permissions it lists.
- **Google**: connect GA4, Search Console, Firebase, and Play for product KPIs (read-only scopes).

## 5. Alerts and incidents

Create alert rules from templates (host CPU high, disk filling, website down, error spike …) and notification channels (email, Slack, webhook). Incidents open and resolve automatically; acknowledge, assign, and comment from **Incidents**.

## 6. Reports and the AI assistant

- **Reports**: a daily or weekly email per product with incidents, hosts, websites, database activity, Google KPIs, and trends against the day before. The summary is written by AI and every number in it is checked against the report; if a number does not match, the report goes out without the summary.
- **Assistant**: ask questions about your product ("why was checkout slow yesterday?"). It answers from tools that read your data, cites its evidence, and can propose (never run) actions.

## 7. Actions

Restarting a service or installing a managed exporter is an **action**: proposed, checked against the environment's policy and the server's own allowlist, approved by someone else in production, executed with a signed single-use task, verified, and audited.

## 8. Your data

- **Usage** shows your telemetry series and samples against the limits.
- **Settings → Data**: owners can export everything (secrets excluded) or delete the organization (30 days to change your mind).
