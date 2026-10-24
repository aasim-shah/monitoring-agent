# pcp_agent

Installs and enrolls the Product Control Plane host agent with the same `install.sh` as the one-liner (WB-05 UC-05-02). Hosts that are already enrolled are left unchanged, so the role can run on every play.

```yaml
- hosts: all
  become: true
  roles:
    - role: pcp_agent
      pcp_agent_token: "{{ vault_pcp_fleet_token }}"
      pcp_agent_control_url: https://agent.example.com
      pcp_agent_download_url: https://monitor.example.com/downloads
```

Create a fleet token in the dashboard (Agents → Add server, with the number of servers) and store it in Ansible Vault as `vault_pcp_fleet_token`. The token expires (at most 24 hours) and enrolls at most the number of servers it was created for.

Upgrades and pack changes run over the agent's own channel afterwards; to re-enroll a host, run `install.sh --force` on it.
