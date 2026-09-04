import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { isSetupComplete } from './lib/secrets';
import { isWorkshopAdmin } from './lib/workshop-auth';

function startsWithPath(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  // Cron and status endpoints must work before and after first-run setup.
  if (startsWithPath(pathname, '/api/lifecycle')) return NextResponse.next();

  const isSetupPath = pathname === '/setup' || startsWithPath(pathname, '/api/setup');
  let ready: boolean;
  try {
    ready = await isSetupComplete();
  } catch (error) {
    console.error('First-run gate could not reach the controller database', error);
    return new NextResponse('Controller database is unavailable. Check the Neon store and DATABASE_URL.', {
      status: 503,
      headers: { 'retry-after': '5', 'cache-control': 'no-store' },
    });
  }

  // First-run gate: until secrets exist, every path leads to /setup.
  if (!ready) {
    if (isSetupPath) return NextResponse.next();
    return NextResponse.redirect(new URL('/setup', request.url), { headers: { 'cache-control': 'no-store' } });
  }

  // Once set up, the setup screen is gone for good.
  if (isSetupPath) {
    return NextResponse.redirect(new URL('/workshop', request.url), { headers: { 'cache-control': 'no-store' } });
  }

  if (startsWithPath(pathname, '/workshop')) {
    if (await isWorkshopAdmin(request)) return NextResponse.next();
    return new NextResponse('Instructor access required', {
      status: 401,
      headers: {
        'www-authenticate': 'Basic realm="Workshop instructor", charset="UTF-8"',
        'cache-control': 'no-store',
      },
    });
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
