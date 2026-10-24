import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot, run } from './compose.js';

const WATCHDOG = `${repoRoot}infrastructure/monitoring/watchdog.sh`;

/** A state dir, a checks file whose results the test controls, and a mailer that records mail. */
function setup() {
  const d = mkdtempSync(join(tmpdir(), 'pcp-watchdog-'));
  const mailer = join(d, 'mailer.sh');
  writeFileSync(
    mailer,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$1" >> "${d}/mail.log"\ncat >> "${d}/mail.log"\n`,
  );
  chmodSync(mailer, 0o755);
  const checks = (api: boolean, vm: boolean) =>
    writeFileSync(
      join(d, 'checks'),
      `api=${api ? 'true' : 'false'}\nvictoriametrics=${vm ? 'true' : 'false'}\n`,
    );
  const tick = () =>
    run('bash', [WATCHDOG], {
      WATCHDOG_STATE: d,
      WATCHDOG_CHECKS: join(d, 'checks'),
      WATCHDOG_MAILER: mailer,
    });
  const mail = () => (existsSync(join(d, 'mail.log')) ? readFileSync(join(d, 'mail.log'), 'utf8') : '');
  return { checks, tick, mail };
}

describe('independent watchdog (M19.5, spec §11.13)', () => {
  it('mails once when a check fails, stays quiet while it keeps failing, and mails once on recovery', async () => {
    const w = setup();
    w.checks(true, true);
    expect((await w.tick()).status).toBe(0);
    expect(w.mail()).toBe('');

    w.checks(false, true);
    expect((await w.tick()).status).toBe(1);
    expect(w.mail()).toMatch(/^\[pcp watchdog\] DOWN: api/m);
    await w.tick();
    expect(w.mail().match(/DOWN: api/g)).toHaveLength(1);

    w.checks(true, true);
    expect((await w.tick()).status).toBe(0);
    expect(w.mail()).toMatch(/\[pcp watchdog\] RECOVERED: api/);
    await w.tick();
    expect(w.mail().match(/RECOVERED: api/g)).toHaveLength(1);
  });

  it('names every failing check and keeps the others quiet', async () => {
    const w = setup();
    w.checks(false, false);
    await w.tick();
    expect(w.mail()).toMatch(/DOWN: api/);
    expect(w.mail()).toMatch(/DOWN: victoriametrics/);
  });
});
