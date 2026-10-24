import { describe, expect, it } from 'vitest';
import { assertFreeDisk } from '../disk-guard.js';

describe('disk guard', () => {
  it('passes with enough space and refuses with a clear message otherwise', () => {
    expect(() => assertFreeDisk(0)).not.toThrow();
    expect(() => assertFreeDisk(1e9)).toThrow(/Not enough free disk: .* GB free, need 1000000000 GB/);
  });
});
