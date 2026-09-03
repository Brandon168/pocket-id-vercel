import { getWorkshopName } from '@/lib/workshop';
import { takeNextSignupToken } from '@/lib/workshop-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const token = await takeNextSignupToken(getWorkshopName());
  if (!token) {
    return new Response('This workshop signup link is unavailable or has expired.', {
      status: 410,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  const url = new URL('/signup', request.url);
  url.searchParams.set('token', token);
  return Response.redirect(url, 307);
}
