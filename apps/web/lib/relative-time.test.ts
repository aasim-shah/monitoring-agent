import { describe, expect, it } from 'vitest';
import { relativeTime } from './relative-time';

const now = new Date('2026-10-22T12:00:00Z');
const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000).toISOString();

describe('relativeTime', () => {
  it('reads naturally', () => {
    expect(relativeTime(null, now)).toBe('never');
    expect(relativeTime(ago(3), now)).toBe('just now');
    expect(relativeTime(ago(45), now)).toBe('45 s ago');
    expect(relativeTime(ago(125), now)).toBe('2 min ago');
    expect(relativeTime(ago(3 * 3600 + 5), now)).toBe('3 h ago');
    expect(relativeTime(ago(2 * 86400), now)).toBe('2 d ago');
  });
});
