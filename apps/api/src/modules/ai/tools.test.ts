import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AI_TOOLS } from './tools.js';

describe('AI tools and data inspection (BR-12-07, TC-12-08)', () => {
  it('no tool is about inspection, and no tool reads inspection requests or peeked messages', () => {
    for (const tool of AI_TOOLS) expect(`${tool.name} ${tool.description}`).not.toMatch(/inspect|peek/i);
    const source = readFileSync(fileURLToPath(new URL('./tools.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(
      /inspectionRequest|inspection_requests|inspect:peek|agentPackAssignment[\s\S]{0,80}inspection/,
    );
  });
});
