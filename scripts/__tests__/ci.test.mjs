import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';

const path = (p) => new URL(`../../${p}`, import.meta.url);
const load = (p) => parse(readFileSync(path(p), 'utf8'));

const JOBS = ['node', 'go', 'openapi', 'smoke', 'e2e', 'sbom', 'osv-scan', 'secret-scan'];

test('ci workflow exists', () => {
  assert.ok(existsSync(path('.github/workflows/ci.yml')));
});

test('ci triggers on pull requests and pushes to main', () => {
  const ci = load('.github/workflows/ci.yml');
  assert.ok('pull_request' in ci.on, 'missing pull_request trigger');
  assert.deepEqual(ci.on.push?.branches, ['main']);
});

test('ci defines every required job', () => {
  const ci = load('.github/workflows/ci.yml');
  assert.deepEqual(Object.keys(ci.jobs).sort(), [...JOBS].sort());
});

test('smoke runs both deployment modes', () => {
  const ci = load('.github/workflows/ci.yml');
  assert.deepEqual(ci.jobs.smoke.strategy.matrix.deployment_mode.sort(), ['managed', 'self_hosted']);
});

test('every action is pinned to a version', () => {
  for (const file of ['.github/workflows/ci.yml', '.github/workflows/nightly-live.yml']) {
    const wf = load(file);
    for (const [name, job] of Object.entries(wf.jobs)) {
      for (const step of job.steps ?? []) {
        if (!step.uses) continue;
        assert.match(
          step.uses,
          /@v\d+(\.\d+){0,2}$|@[0-9a-f]{40}$/,
          `${file} ${name}: unpinned ${step.uses}`,
        );
      }
    }
  }
});

test('nightly live workflow is scheduled', () => {
  const nightly = load('.github/workflows/nightly-live.yml');
  assert.ok(Array.isArray(nightly.on.schedule) && nightly.on.schedule.length > 0);
});
