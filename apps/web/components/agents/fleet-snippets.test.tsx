import { describe, expect, it } from 'vitest';
import { ansibleSnippet, cloudInitSnippet, composeSnippet } from './fleet-snippets';

const install = {
  token: 'pcp_enr_secret',
  controlUrl: 'https://agent.monitor.example.com',
  downloadUrl: 'https://monitor.example.com/downloads',
  installScriptUrl: 'https://monitor.example.com/install.sh',
};

describe('fleet snippets (UC-05-02..04)', () => {
  it('Ansible keeps the token in the vault, not the playbook', () => {
    const s = ansibleSnippet(install);
    expect(s.playbook).toContain('role: pcp_agent');
    expect(s.playbook).toContain('pcp_agent_token: "{{ vault_pcp_fleet_token }}"');
    expect(s.playbook).toContain(`pcp_agent_control_url: ${install.controlUrl}`);
    expect(s.playbook).toContain(`pcp_agent_download_url: ${install.downloadUrl}`);
    expect(s.playbook).not.toContain(install.token);
    expect(s.vault).toBe(`vault_pcp_fleet_token: ${install.token}`);
    expect(s.getRole).toBe(
      `curl -fsSL ${install.downloadUrl}/install/pcp_agent-role.tar.gz | tar -xz -C roles`,
    );
  });

  it('cloud-init enrolls on first boot', () => {
    const s = cloudInitSnippet(install);
    expect(s.split('\n')[0]).toBe('#cloud-config');
    expect(s).toContain(
      `  - curl -fsSL ${install.installScriptUrl} | bash -s -- --token ${install.token} --control-url ${install.controlUrl} --download-url ${install.downloadUrl}`,
    );
  });

  it('the Compose profile passes the token as an environment variable', () => {
    const s = composeSnippet(install);
    expect(s).toContain(`curl -fsSL ${install.downloadUrl}/install/compose-agent.tar.gz | tar -xz`);
    expect(s).toContain(
      `PCP_TOKEN=${install.token} PCP_CONTROL_URL=${install.controlUrl} PCP_DOWNLOAD_URL=${install.downloadUrl} docker compose up -d --build`,
    );
  });
});
