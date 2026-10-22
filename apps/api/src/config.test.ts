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
});
