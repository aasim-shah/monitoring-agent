import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { middleware } from './middleware';

const req = (path: string, cookie?: string) =>
  new NextRequest(new URL(path, 'http://localhost:8080'), cookie ? { headers: { cookie } } : undefined);

describe('middleware', () => {
  it('redirects to login with next when there is no session cookie', () => {
    const res = middleware(req('/orgs/abc?tab=members'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(
      'http://localhost:8080/login?next=%2Forgs%2Fabc%3Ftab%3Dmembers',
    );
  });

  it.each(['/login', '/signup', '/verify?token=x', '/reset'])('lets %s through', (path) => {
    expect(middleware(req(path)).headers.get('x-middleware-next')).toBe('1');
  });

  it('lets signed-in requests through', () => {
    expect(middleware(req('/orgs', 'pcp_session=abc')).headers.get('x-middleware-next')).toBe('1');
  });
});
