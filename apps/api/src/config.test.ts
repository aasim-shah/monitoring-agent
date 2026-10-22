import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const base = { DATABASE_URL: 'postgres://u:p@postgres:5432/pcp', REDIS_URL: 'redis://redis:6379' };

describe('loadConfig', () => {
  it('defaults deployment mode to managed and port to 3000', () => {
    expect(loadConfig(base)).toMatchObject({ deploymentMode: 'managed', port: 3000 });
  });
  it('accepts self_hosted', () => {
    expect(loadConfig({ ...base, DEPLOYMENT_MODE: 'self_hosted' }).deploymentMode).toBe('self_hosted');
  });
  it('rejects an unknown deployment mode', () => {
    expect(() => loadConfig({ ...base, DEPLOYMENT_MODE: 'cloud' })).toThrow(/DEPLOYMENT_MODE/);
  });
  it('requires DATABASE_URL', () => {
    expect(() => loadConfig({ REDIS_URL: base.REDIS_URL })).toThrow(/DATABASE_URL/);
  });
  it('treats empty optional values as unset (Compose passes "" for unset ${VAR:-})', () => {
    const c = loadConfig({
      ...base,
      SMTP_URL: '',
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '',
      GOOGLE_REDIRECT_URI: '',
    });
    expect(c.smtpUrl).toBeUndefined();
    expect(c.google).toBeUndefined();
  });

  it('agent settings are all-or-nothing', () => {
    expect(loadConfig(base).agents).toBeUndefined();
    expect(() => loadConfig({ ...base, AGENT_CA_CERT: 'eA==' })).toThrow(/AGENT_CA_KEY/);
  });

  it('parses agent settings and proxy addresses', () => {
    const pem = (s: string) => Buffer.from(s).toString('base64');
    const c = loadConfig({
      ...base,
      AGENT_CA_CERT: pem('cert'),
      AGENT_CA_KEY: pem('key'),
      AGENT_CA_CHAIN: pem('chain'),
      TASK_SIGNING_KEY: pem('ed'),
      AGENT_CONTROL_URL: 'https://agent.example.com',
      AGENT_INGEST_URL: 'https://ingest.example.com',
      AGENT_OPAMP_URL: 'wss://agent.example.com/agent/v1/opamp',
      AGENT_PROXY_ADDRESSES: '172.30.0.10, 10.0.0.1',
    });
    expect(c.agents).toEqual({
      caCertPem: 'cert',
      caKeyPem: 'key',
      chainPem: 'chain',
      taskSigningKeyPem: 'ed',
      controlUrl: 'https://agent.example.com',
      ingestUrl: 'https://ingest.example.com',
      opampUrl: 'wss://agent.example.com/agent/v1/opamp',
      proxyAddresses: ['172.30.0.10', '10.0.0.1'],
    });
  });
});
