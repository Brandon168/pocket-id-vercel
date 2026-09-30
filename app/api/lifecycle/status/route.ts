import { getControllerStatus, publicControllerStatus } from '@/lib/sandbox-control';
import { isWorkshopAdmin } from '@/lib/workshop-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Public health check. The instructor (session cookie or Basic auth) also
// gets the Sandbox origin, lease, and last startup error for troubleshooting.
export async function GET(request: Request): Promise<Response> {
  try {
    const status = await getControllerStatus();
    const detailed = await isWorkshopAdmin(request).catch(() => false);
    return Response.json(detailed ? status : publicControllerStatus(status), {
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) {
    console.error('Lifecycle status failed', error);
    return Response.json({ error: 'Lifecycle status is unavailable' }, { status: 500, headers: { 'cache-control': 'no-store' } });
  }
}
