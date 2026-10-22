import { describe, expect, it } from 'vitest';
import { safeNext } from './safe-next';

describe('safeNext (Review Focus #5)', () => {
  it.each(['/orgs/a', '/invitations/accept?token=abc', '/orgs/a/products/b#env'])(
    'keeps same-origin path %s',
    (p) => {
      expect(safeNext(p)).toBe(p);
    },
  );

  it.each([
    null,
    '',
    '//evil.com',
    'https://evil.com',
    '/\\evil.com',
    'javascript:alert(1)',
    'orgs',
    '/\n/evil',
    '/%2F%2Fevil.com',
  ])('rejects %s', (p) => {
    expect(safeNext(p)).toBe('/orgs');
  });
});
