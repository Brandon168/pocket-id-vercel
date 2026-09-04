import { isWorkshopAdmin, workshopUnauthorized } from '@/lib/workshop-auth';
import { getSignupProgress } from '@/lib/workshop';

export const runtime = 'nodejs';
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  if (!(await isWorkshopAdmin(request))) return workshopUnauthorized();
  try {
    return Response.json(await getSignupProgress(), { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    console.error('Signup progress failed', error);
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
