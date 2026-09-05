import { getKnownSandboxOrigin } from '@/lib/sandbox-control';
import { getWorkshopName } from '@/lib/workshop';
import { takeNextSignupToken } from '@/lib/workshop-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Pocket ID's session cookies (https deployments use the __Host- prefix).
const pocketSessionCookies = ['__Host-access_token', '__Host-session'];

function hasPocketSession(request: Request): boolean {
  const cookie = request.headers.get('cookie') ?? '';
  return cookie.split(';').some((part) => part.trim().startsWith('__Host-access_token='));
}

function clearPocketSessionHeaders(): Headers {
  const headers = new Headers({ 'cache-control': 'no-store' });
  for (const name of pocketSessionCookies) {
    headers.append('set-cookie', `${name}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`);
  }
  return headers;
}

async function currentUsername(request: Request): Promise<string | null> {
  try {
    const origin = await getKnownSandboxOrigin();
    const response = await fetch(`${origin}/api/users/me`, {
      headers: { cookie: request.headers.get('cookie') ?? '' },
      cache: 'no-store',
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) return null;
    const me = (await response.json()) as { username?: string };
    return me.username ?? null;
  } catch {
    return null;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);
}

// Shown when the device is already signed in to Pocket ID: an attendee
// re-scanning the QR, or the instructor testing it. Without this, Pocket ID
// silently sends signed-in visitors to their account page.
function alreadySignedIn(username: string | null): Response {
  const who = username ? `as <code>${escapeHtml(username)}</code>` : 'to this workshop';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Already signed in</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fafafa;color:#171717;font:16px/1.55 system-ui,-apple-system,Segoe UI,sans-serif}
main{width:min(440px,calc(100% - 32px));padding:28px;border:1px solid #eaeaea;border-radius:14px;background:#fff}
h1{margin:0 0 8px;font-size:22px;letter-spacing:-.02em}p{margin:0 0 20px;color:#666}code{font-family:ui-monospace,Menlo,monospace}
a{display:block;padding:11px 14px;border-radius:8px;text-align:center;text-decoration:none;font-weight:500}
.primary{background:#000;color:#fff;margin-bottom:10px}.secondary{border:1px solid #eaeaea;color:#171717}
</style></head><body><main>
<h1>This device is already signed in</h1>
<p>You are signed in ${who}. Registering someone else on this device signs the current account out first.</p>
<a class="primary" href="/settings/account">Continue to my account</a>
<a class="secondary" href="/join?new=1">Sign out and register a new attendee</a>
</main></body></html>`;
  return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const startFresh = url.searchParams.get('new') === '1';
  if (hasPocketSession(request) && !startFresh) {
    return alreadySignedIn(await currentUsername(request));
  }
  const token = await takeNextSignupToken(getWorkshopName());
  if (!token) {
    return new Response('This workshop signup link is unavailable or has expired.', {
      status: 410,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  const signup = new URL('/signup', request.url);
  signup.searchParams.set('token', token);
  const headers = startFresh ? clearPocketSessionHeaders() : new Headers({ 'cache-control': 'no-store' });
  headers.set('location', signup.toString());
  return new Response(null, { status: 307, headers });
}
