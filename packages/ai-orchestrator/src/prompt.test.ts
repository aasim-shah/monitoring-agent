import { describe, expect, it } from 'vitest';
import { systemPrompt } from './prompt.js';

describe('systemPrompt', () => {
  it('states the timezone with its UTC offset and the exact "yesterday" window', () => {
    const p = systemPrompt({
      productName: 'storage',
      timezone: 'Asia/Karachi',
      now: new Date('2026-10-23T10:00:00Z'),
    });
    expect(p).toContain('Today is 2026-10-23 in the organization timezone Asia/Karachi (UTC+05:00)');
    expect(p).toContain('"Yesterday" means 2026-10-22 00:00 to 24:00 Asia/Karachi');
  });
});
