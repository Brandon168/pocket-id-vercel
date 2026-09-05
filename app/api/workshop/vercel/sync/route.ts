import { isWorkshopAdmin, workshopUnauthorized } from '@/lib/workshop-auth';
import { getVercelTeamStatus, syncVercelDirectory } from '@/lib/workshop';

export const runtime = 'nodejs';
export const maxDuration = 120;
export const dynamic = 'force-dynamic';

// Pushes users and groups to Vercel now instead of waiting for Pocket ID's
// five-minute debounce. Useful right after a stuck attendee is fixed.
export async function POST(request: Request): Promise<Response> {
  if (!(await isWorkshopAdmin(request))) return workshopUnauthorized();
  try {
    await syncVercelDirectory();
    return Response.json(await getVercelTeamStatus(new URL(request.url).origin), { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    console.error('Directory Sync run failed', error);
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
