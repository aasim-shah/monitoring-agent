import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const read = (p) => parse(readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8'));
const base = read('compose.yaml');
const vps = read('deploy/vps/compose.vps.yaml');

test('vmalert notifies the api internal receiver with the internal token (M12, BR-13-08)', () => {
  const cmd = base.services.vmalert.command;
  assert.ok(cmd.includes('-notifier.url=http://api:3000/internal/alertmanager'));
  assert.ok(cmd.some((a) => a.startsWith('-notifier.headers=X-Internal-Token:${INTERNAL_TOKEN')));
  assert.ok(!cmd.includes('-notifier.blackhole'));
  assert.ok(cmd.includes('-rule=/etc/vmalert/tenants/*.yaml'));
  assert.ok(cmd.includes('-configCheckInterval=1m'));
});

test('tenant rule files live in a volume the api writes and vmalert only reads', () => {
  assert.ok('alert-rules' in base.volumes);
  assert.ok(base.services.api.volumes.includes('alert-rules:/var/lib/pcp/alert-rules'));
  assert.ok(base.services.vmalert.volumes.includes('alert-rules:/etc/vmalert/tenants:ro'));
  assert.equal(base.services.api.environment.ALERT_RULES_DIR, '/var/lib/pcp/alert-rules');
  assert.equal(base.services.api.environment.VMALERT_URL, 'http://vmalert:8880');
});

test('the worker can send notifications', () => {
  const env = base.services.worker.environment;
  for (const k of ['SMTP_URL', 'MAIL_FROM', 'APP_ORIGIN']) assert.ok(k in env, k);
});

test('vmalert is capped on a shared VPS', () => {
  assert.ok(vps.services.vmalert?.deploy?.resources?.limits?.memory);
});

test('the api receives the AI provider settings from the environment (M14)', () => {
  const env = base.services.api.environment;
  for (const k of [
    'AI_PROVIDER',
    'AI_MODEL',
    'AI_FALLBACK_PROVIDER',
    'AI_FALLBACK_MODEL',
    'GEMINI_API_KEY',
    'GROQ_API_KEY',
  ])
    assert.ok(k in env, k);
});

test('the worker writes website probe samples to VictoriaMetrics (M13a)', () => {
  assert.equal(base.services.worker.environment.VM_IMPORT_URL, 'http://victoriametrics:8428');
  assert.ok(
    !('PCP_PROBE_ALLOWLIST' in base.services.worker.environment),
    'allowlist is for test stacks only',
  );
});

test('the worker queries telemetry and the AI providers for daily reports (M15)', () => {
  const env = base.services.worker.environment;
  assert.equal(env.VM_QUERY_URL, 'http://victoriametrics:8428');
  for (const key of [
    'AI_PROVIDER',
    'AI_MODEL',
    'AI_FALLBACK_PROVIDER',
    'AI_FALLBACK_MODEL',
    'GEMINI_API_KEY',
    'GROQ_API_KEY',
  ])
    assert.ok(key in env, `${key} reaches the worker`);
});
