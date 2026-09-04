import { getKnownSandboxOrigin, invalidateKnownSandboxOrigin, recordProxyActivity } from '@/lib/sandbox-control';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const hopByHopHeaders: Record<string, true> = {
  connection: true,
  'keep-alive': true,
  'proxy-authenticate': true,
  'proxy-authorization': true,
  te: true,
  trailer: true,
  'transfer-encoding': true,
  upgrade: true,
  host: true,
};

const controllerPaths = ['/setup', '/workshop', '/join', '/api/setup', '/api/workshop', '/api/lifecycle'];

function isControllerPath(pathname: string): boolean {
  return controllerPaths.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

async function proxy(request: Request): Promise<Response> {
  try {
    const inboundUrl = new URL(request.url);
    if (isControllerPath(inboundUrl.pathname)) {
      return new Response('Not found', { status: 404 });
    }
    const origin = await getKnownSandboxOrigin();
    await recordProxyActivity();
    const upstreamUrl = new URL(inboundUrl.pathname + inboundUrl.search, origin);
    const headers = new Headers(request.headers);
    for (const name of Object.keys(hopByHopHeaders)) headers.delete(name);
    headers.set('x-forwarded-host', inboundUrl.host);
    headers.set('x-forwarded-proto', inboundUrl.protocol.slice(0, -1));

    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    const response = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      body: hasBody ? await request.arrayBuffer() : undefined,
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(45_000),
    });
    const responseHeaders = new Headers(response.headers);
    for (const name of Object.keys(hopByHopHeaders)) responseHeaders.delete(name);
    const location = responseHeaders.get('location');
    if (location) {
      const externalOrigin = inboundUrl.origin;
      responseHeaders.set('location', location.replace(origin, externalOrigin));
    }
    const bodyless = request.method === 'HEAD' || response.status === 204 || response.status === 304;
    const body = bodyless ? null : new Uint8Array(await response.arrayBuffer());
    responseHeaders.delete('content-encoding');
    if (body) responseHeaders.set('content-length', String(body.byteLength));
    else responseHeaders.delete('content-length');
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    invalidateKnownSandboxOrigin();
    console.error('Pocket ID proxy failed', error);
    return Response.json(
      { error: 'Pocket ID is starting. Retry in a few seconds.' },
      { status: 503, headers: { 'retry-after': '2', 'cache-control': 'no-store' } },
    );
  }
}

export const GET = proxy;
export const HEAD = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;
