import { isWorkshopAdmin, workshopUnauthorized } from '@/lib/workshop-auth';
import { AttendeeNotFoundError, issueAttendeeLogin } from '@/lib/workshop';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  if (!(await isWorkshopAdmin(request))) return workshopUnauthorized();
  try {
    const body = await request.json().catch(() => ({})) as { userId?: unknown; username?: unknown };
    const selector = {
      userId: typeof body.userId === 'string' ? body.userId : undefined,
      username: typeof body.username === 'string' ? body.username : undefined,
    };
    const login = await issueAttendeeLogin(new URL(request.url).origin, selector);
    return Response.json(login, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    if (error instanceof AttendeeNotFoundError) {
      return Response.json({ error: error.message }, { status: 404, headers: { 'cache-control': 'no-store' } });
    }
    console.error('Attendee login link failed', error);
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
