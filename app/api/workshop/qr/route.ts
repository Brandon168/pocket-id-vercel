import QRCode from 'qrcode';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const requestUrl = new URL(request.url);
  const value = requestUrl.searchParams.get('url');
  if (!value) return new Response('Missing URL', { status: 400 });
  const allowedOrigin = (process.env.APP_URL ?? requestUrl.origin).replace(/\/$/, '');
  if (value !== `${allowedOrigin}/join`) return new Response('Invalid URL', { status: 400 });

  const svg = await QRCode.toString(value, {
    type: 'svg',
    width: 960,
    margin: 3,
    errorCorrectionLevel: 'M',
    color: { dark: '#000000', light: '#ffffff' },
  });
  const headers: Record<string, string> = {
    'content-type': 'image/svg+xml; charset=utf-8',
    'cache-control': 'public, max-age=3600',
  };
  if (requestUrl.searchParams.get('download')) {
    headers['content-disposition'] = 'attachment; filename="workshop-signup-qr.svg"';
  }
  return new Response(svg, { headers });
}
