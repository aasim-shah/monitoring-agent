import { describe, expect, it } from 'vitest';
import { supportsLiveTail } from './agent-version.js';

describe('supportsLiveTail', () => {
  it('needs agent 0.2.0 or later', () => {
    expect(supportsLiveTail('0.1.0')).toBe(false);
    expect(supportsLiveTail('0.1.9')).toBe(false);
    expect(supportsLiveTail('0.2.0')).toBe(true);
    expect(supportsLiveTail('0.10.0')).toBe(true);
    expect(supportsLiveTail('1.0.0')).toBe(true);
    expect(supportsLiveTail('dev')).toBe(false);
  });
});
