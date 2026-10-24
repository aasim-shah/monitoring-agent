# Agent on a Docker host

Runs the host agent as a container (WB-05 UC-05-04). Get the command from the dashboard (Agents → Add server → Docker):

```bash
curl -fsSL https://monitor.example.com/downloads/install/compose-agent.tar.gz | tar -xz && cd compose-agent
PCP_TOKEN=pcp_enr_... PCP_CONTROL_URL=https://agent.example.com PCP_DOWNLOAD_URL=https://monitor.example.com/downloads docker compose up -d --build
```

The token is used once; the identity is kept in the `pcp-agent` volume. Mounts are read-only: `/` at `/hostfs` (host metrics), `/etc/machine-id`, and `/etc/os-release`. The container shares the host's PID, network, and UTS namespaces so it sees host processes, reaches services on `127.0.0.1`, and reports the host's name. It drops all capabilities, has a read-only filesystem, and publishes no port. The Docker socket is not mounted.

To remove: `docker compose down -v` and revoke the agent in the dashboard.
