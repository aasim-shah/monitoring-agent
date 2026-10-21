import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';

const dir = new URL('../../docs/adr/', import.meta.url);

const EXPECTED = [
  '0000-template.md',
  '0001-modular-monolith.md',
  '0002-toolchain-and-versions.md',
  '0003-tenancy-and-rls.md',
  '0004-secrets.md',
  '0005-agent-architecture.md',
  '0006-agent-identity-and-mtls.md',
  '0007-telemetry-protocols-and-storage.md',
  '0008-connector-sdk.md',
  '0009-asset-identity-and-graph.md',
  '0010-ai-orchestration.md',
  '0011-actions-and-privileged-helper.md',
  '0012-deployment-modes.md',
  '0013-installation-methods.md',
  '0014-testing-strategy.md',
  '0015-google-authorization.md',
];

test('ADR directory contains template and ADRs 0001-0015', () => {
  assert.ok(existsSync(dir), 'docs/adr missing');
  const files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  assert.deepEqual(files, EXPECTED);
});

for (const file of EXPECTED.slice(1)) {
  test(`${file} has status, required sections, and references`, () => {
    const text = readFileSync(new URL(file, dir), 'utf8');
    assert.match(text, /^Status: (Proposed|Accepted|Superseded)/m, 'missing Status line');
    for (const section of ['## Context', '## Decision', '## Consequences', '## References']) {
      assert.ok(text.includes(section), `missing ${section}`);
    }
    assert.match(text, /\bD\d+\b|§\d+/, 'must reference a master-plan decision (D#) or spec section (§#)');
  });
}
