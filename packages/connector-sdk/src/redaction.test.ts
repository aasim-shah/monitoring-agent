import { describe, expect, it } from 'vitest';
import { redactSecrets } from './index.js';

describe('redactSecrets', () => {
  it('replaces every occurrence of each secret', () => {
    expect(redactSecrets('token abc123secret rejected; abc123secret again', ['abc123secret'])).toBe(
      'token [REDACTED] rejected; [REDACTED] again',
    );
  });
  it('ignores very short values (would mangle unrelated text)', () => {
    expect(redactSecrets('a b c', ['a'])).toBe('a b c');
  });
  it('handles regex characters in secrets', () => {
    expect(redactSecrets('key=a.b*c+?', ['a.b*c+?'])).toBe('key=[REDACTED]');
  });
});
