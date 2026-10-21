import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const json = (p) => JSON.parse(read(p));

test('root package pins pnpm and node and uses exact versions', () => {
  const pkg = json('package.json');
  assert.equal(pkg.packageManager, 'pnpm@9.15.9');
  assert.equal(pkg.engines.node, '>=22');
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const [name, version] of Object.entries(deps)) {
    assert.ok(!/^[\^~]/.test(version), `${name} must be pinned exactly, got ${version}`);
  }
});

test('workspace lists all package globs', () => {
  const ws = read('pnpm-workspace.yaml');
  for (const glob of ['apps/*', 'packages/*', 'packages/connectors/*', 'agents/*', 'tests']) {
    assert.ok(ws.includes(`'${glob}'`), `pnpm-workspace.yaml missing ${glob}`);
  }
});

test('turbo defines build, lint, typecheck, test', () => {
  const turbo = json('turbo.json');
  for (const task of ['build', 'lint', 'typecheck', 'test']) {
    assert.ok(turbo.tasks?.[task], `turbo.json missing task ${task}`);
  }
});

test('base tsconfig is strict NodeNext', () => {
  const ts = json('tsconfig.base.json');
  assert.equal(ts.compilerOptions.strict, true);
  assert.equal(ts.compilerOptions.module, 'NodeNext');
});
