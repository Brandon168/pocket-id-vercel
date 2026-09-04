import { isWorkshopAdmin, workshopUnauthorized } from '@/lib/workshop-auth';
import { listAttendees } from '@/lib/workshop';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  if (!(await isWorkshopAdmin(request))) return workshopUnauthorized();
  try {
    const url = new URL(request.url);
    const search = url.searchParams.get('search') ?? '';
    const page = Number(url.searchParams.get('page') ?? '1') || 1;
    return Response.json(await listAttendees(search, page), { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    console.error('Attendee list failed', error);
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
