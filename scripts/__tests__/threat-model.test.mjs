import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const spec = read('AI_Product_Control_Plane_Architecture_and_Flows.md');
const plan = read('docs/superpowers/plans/2026-10-21-ai-product-control-plane.md');

function section(text, startHeading, endHeading) {
  const start = text.indexOf(startHeading);
  const end = text.indexOf(endHeading, start + startHeading.length);
  assert.ok(start >= 0 && end > start, `section ${startHeading} not found`);
  return text.slice(start, end);
}

function firstColumn(tableText) {
  return tableText
    .split('\n')
    .filter((l) => l.startsWith('| ') && !l.startsWith('|---'))
    .slice(1) // header row
    .map((l) => l.split('|')[1].trim());
}

const threats = firstColumn(section(spec, '### 18.1 Major threats', '### 18.2'));
const dataClasses = firstColumn(section(spec, '### 11.1 Data classes', '### 11.2'));
const planTaskIds = new Set([...plan.matchAll(/^\*\*(M\d+\.\d+) /gm)].map((m) => m[1]));

test('spec tables parsed', () => {
  assert.ok(threats.length >= 18, `expected ≥18 threats, got ${threats.length}`);
  assert.equal(dataClasses.length, 9);
});

test('threat model file exists', () => {
  assert.ok(existsSync(new URL('../../docs/security/threat-model.md', import.meta.url)));
});

for (const threat of threats) {
  test(`threat "${threat}" has a section with existing owning tasks`, () => {
    const model = read('docs/security/threat-model.md');
    const heading = `### ${threat}\n`;
    const start = model.indexOf(heading);
    assert.ok(start >= 0, `missing heading "### ${threat}"`);
    const next = model.indexOf('\n### ', start + heading.length);
    const body = model.slice(start, next === -1 ? undefined : next);
    const owning = body.match(/^Owning tasks: (.+)$/m);
    assert.ok(owning, 'missing "Owning tasks:" line');
    const ids = owning[1].match(/M\d+\.\d+/g) ?? [];
    assert.ok(ids.length > 0, 'no task IDs listed');
    for (const id of ids) assert.ok(planTaskIds.has(id), `task ${id} not in master plan`);
  });
}

test('data classification lists every spec data class with LLM eligibility', () => {
  const text = read('docs/security/data-classification.md');
  assert.ok(text.includes('LLM eligible'), 'missing LLM eligible column');
  for (const cls of dataClasses) assert.ok(text.includes(`| ${cls} |`), `missing data class ${cls}`);
});
