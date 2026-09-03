import { isWorkshopAdmin, workshopUnauthorized } from '@/lib/workshop-auth';
import { setupWorkshop } from '@/lib/workshop';

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  if (!isWorkshopAdmin(request)) return workshopUnauthorized();
  try {
    const setup = await setupWorkshop(new URL(request.url).origin);
    return Response.json(setup, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    console.error('Workshop setup failed', error);
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
