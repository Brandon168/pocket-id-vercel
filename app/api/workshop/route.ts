import { isWorkshopAdmin, workshopUnauthorized } from '@/lib/workshop-auth';
import { getWorkshopName } from '@/lib/workshop';
import { getWorkshopSetup } from '@/lib/workshop-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  if (!isWorkshopAdmin(request)) return workshopUnauthorized();
  try {
    return Response.json(await getWorkshopSetup(getWorkshopName()), {
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) {
    console.error('Workshop status failed', error);
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
