import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const base = {
  REDIS_URL: 'redis://redis:6379',
  DATABASE_URL: 'postgres://pcp_app:x@postgres:5432/pcp',
  SCHEDULER_DATABASE_URL: 'postgres://pcp_scheduler:x@postgres:5432/pcp',
};

describe('worker config', () => {
  it('reads database, scheduler, and Redis URLs with defaults', () => {
    expect(loadConfig(base)).toMatchObject({
      deploymentMode: 'managed',
      healthPort: 3002,
      databaseUrl: base.DATABASE_URL,
      schedulerDatabaseUrl: base.SCHEDULER_DATABASE_URL,
      reconcileEverySeconds: 60,
    });
  });
  it.each(['DATABASE_URL', 'SCHEDULER_DATABASE_URL', 'REDIS_URL'])('requires %s', (name) => {
    const { [name as keyof typeof base]: _omit, ...rest } = base;
    expect(() => loadConfig(rest)).toThrow(new RegExp(name));
  });
  it('treats empty values as unset', () => {
    expect(() => loadConfig({ ...base, DATABASE_URL: '' })).toThrow(/DATABASE_URL/);
  });
  it('reads mail and the dashboard origin for notifications (M12.3)', () => {
    expect(loadConfig(base)).toMatchObject({
      smtpUrl: undefined,
      mailFrom: 'Product Control Plane <alerts@localhost>',
      appOrigin: 'http://localhost:8080',
    });
    expect(
      loadConfig({
        ...base,
        SMTP_URL: 'smtp://mailpit:1025',
        MAIL_FROM: 'PCP <alerts@example.com>',
        APP_ORIGIN: 'https://monitor.example.com/',
      }),
    ).toMatchObject({
      smtpUrl: 'smtp://mailpit:1025',
      mailFrom: 'PCP <alerts@example.com>',
      appOrigin: 'https://monitor.example.com',
    });
  });
  it('reads the VictoriaMetrics import URL and the probe allowlist (M13a)', () => {
    expect(loadConfig(base)).toMatchObject({ vmImportUrl: undefined, probeAllowlist: [] });
    expect(
      loadConfig({
        ...base,
        VM_IMPORT_URL: 'http://victoriametrics:8428/',
        PCP_PROBE_ALLOWLIST: 'web:3000, api:3000',
      }),
    ).toMatchObject({ vmImportUrl: 'http://victoriametrics:8428', probeAllowlist: ['web:3000', 'api:3000'] });
  });
  it('reads the telemetry query URL and the AI providers for report narratives (M15)', () => {
    expect(loadConfig(base)).toMatchObject({ vmQueryUrl: undefined, ai: { providers: [], fake: false } });
    expect(
      loadConfig({
        ...base,
        VM_QUERY_URL: 'http://victoriametrics:8428/',
        AI_PROVIDER: 'gemini',
        GEMINI_API_KEY: 'g-key-123456',
        PCP_AI_FAKE: '',
      }),
    ).toMatchObject({
      vmQueryUrl: 'http://victoriametrics:8428',
      ai: {
        providers: [{ provider: 'gemini', model: 'gemini-2.5-flash', apiKey: 'g-key-123456' }],
        fake: false,
      },
    });
  });
});
