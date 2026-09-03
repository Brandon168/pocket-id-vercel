import { ensureSandboxReady } from '@/lib/sandbox-control';

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

async function proxy(request: Request): Promise<Response> {
  try {
    const origin = await ensureSandboxReady();
    const inboundUrl = new URL(request.url);
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
    const body = request.method === 'HEAD' ? null : new Uint8Array(await response.arrayBuffer());
    responseHeaders.delete('content-encoding');
    responseHeaders.set('content-length', String(body?.byteLength ?? 0));
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
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
