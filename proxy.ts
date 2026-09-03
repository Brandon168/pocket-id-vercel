import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { isWorkshopAdmin } from './lib/workshop-auth';

export function proxy(request: NextRequest) {
  if (isWorkshopAdmin(request)) return NextResponse.next();
  return new NextResponse('Instructor access required', {
    status: 401,
    headers: {
      'www-authenticate': 'Basic realm="Workshop instructor", charset="UTF-8"',
      'cache-control': 'no-store',
    },
  });
}

export const config = {
  matcher: ['/workshop/:path*'],
};
