import { getControllerStatus } from '@/lib/sandbox-control';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  try {
    return Response.json(await getControllerStatus(), {
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) {
    console.error('Lifecycle status failed', error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
