import { NextResponse, type NextRequest } from 'next/server';

const PUBLIC_PATHS = ['/login', '/signup', '/verify', '/reset'];
const SESSION_COOKIE = 'pcp_session';

/**
 * Sends visitors without a session cookie to /login. The cookie is only a hint for
 * navigation; the API validates the session on every request.
 */
export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (pathname === '/') return NextResponse.next();
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return NextResponse.next();
  if (req.cookies.get(SESSION_COOKIE)) return NextResponse.next();
  const login = new URL('/login', req.url);
  login.searchParams.set('next', pathname + search);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ['/((?!api|_next|healthz|favicon.ico|.*\\..*).*)'],
};
