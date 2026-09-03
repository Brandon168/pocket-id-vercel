import { stopSandboxNow } from '@/lib/sandbox-control';

export const runtime = 'nodejs';
export const maxDuration = 120;
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.LIFECYCLE_ADMIN_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  try {
    await stopSandboxNow();
    return Response.json({ ok: true, result: 'stopped' });
  } catch (error) {
    console.error('Manual lifecycle stop failed', error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
