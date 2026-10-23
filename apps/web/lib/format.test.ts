import { describe, expect, it } from 'vitest';
import { formatValue } from './format';

describe('formatValue', () => {
  it('formats milliseconds', () => {
    expect(formatValue(249.6, 'ms')).toBe('250 ms');
    expect(formatValue(1840, 'ms')).toBe('1.84 s');
  });

  it('formats every chart unit', () => {
    expect(formatValue(12.345, 'percent')).toBe('12.3%');
    expect(formatValue(2048, 'bytesPerSecond')).toBe('2.0 KB/s');
    expect(formatValue(5 * 1024 * 1024, 'bytes')).toBe('5.0 MB');
    expect(formatValue(512, 'bytes')).toBe('512 B');
    expect(formatValue(3, 'count')).toBe('3');
    expect(formatValue(2.5, 'count')).toBe('2.5');
    expect(formatValue(1234.5, 'perSecond')).toBe('1,235/s');
    expect(formatValue(0.25, 'perSecond')).toBe('0.25/s');
  });
});
