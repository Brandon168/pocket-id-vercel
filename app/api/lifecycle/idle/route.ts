import { stopIfIdle } from '@/lib/sandbox-control';

export const runtime = 'nodejs';
export const maxDuration = 120;
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get('authorization') !== `Bearer ${secret}`) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  try {
    const result = await stopIfIdle();
    return Response.json({ ok: true, result });
  } catch (error) {
    console.error('Idle lifecycle check failed', error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
