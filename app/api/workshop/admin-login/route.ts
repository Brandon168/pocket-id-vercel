import { isWorkshopAdmin, workshopUnauthorized } from '@/lib/workshop-auth';
import { refreshAdminLogin } from '@/lib/workshop';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  if (!(await isWorkshopAdmin(request))) return workshopUnauthorized();
  try {
    return Response.json(await refreshAdminLogin(new URL(request.url).origin), {
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) {
    console.error('Admin login refresh failed', error);
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
