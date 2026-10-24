/** What fleet tooling needs from an enrollment (M17.1): the shown-once token and the platform URLs. */
export interface InstallParams {
  token: string;
  controlUrl: string;
  downloadUrl: string;
  installScriptUrl: string;
}

/** UC-05-02: the role wraps install.sh; the token lives in Ansible Vault, never in the playbook. */
export function ansibleSnippet(p: InstallParams) {
  return {
    getRole: `curl -fsSL ${p.downloadUrl}/install/pcp_agent-role.tar.gz | tar -xz -C roles`,
    vault: `vault_pcp_fleet_token: ${p.token}`,
    playbook: [
      '- hosts: all',
      '  become: true',
      '  roles:',
      '    - role: pcp_agent',
      '      pcp_agent_token: "{{ vault_pcp_fleet_token }}"',
      `      pcp_agent_control_url: ${p.controlUrl}`,
      `      pcp_agent_download_url: ${p.downloadUrl}`,
    ].join('\n'),
  };
}

/** UC-05-03: new servers enroll on first boot (cloud-init runs runcmd as root). */
export function cloudInitSnippet(p: InstallParams) {
  return [
    '#cloud-config',
    'runcmd:',
    `  - curl -fsSL ${p.installScriptUrl} | bash -s -- --token ${p.token} --control-url ${p.controlUrl} --download-url ${p.downloadUrl}`,
  ].join('\n');
}

/** UC-05-04: the agent as a container with read-only host mounts. */
export function composeSnippet(p: InstallParams) {
  return [
    `curl -fsSL ${p.downloadUrl}/install/compose-agent.tar.gz | tar -xz && cd compose-agent`,
    `PCP_TOKEN=${p.token} PCP_CONTROL_URL=${p.controlUrl} PCP_DOWNLOAD_URL=${p.downloadUrl} docker compose up -d --build`,
  ].join('\n');
}
