import { isWorkshopAdmin, workshopUnauthorized } from '@/lib/workshop-auth';
import { getSignupProgress, InvalidInputError, PrepareInProgressError, renewSignupTokens } from '@/lib/workshop';

export const runtime = 'nodejs';
export const maxDuration = 120;
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

// Renews signup for another 72 hours with fresh tokens behind the same /join link.
export async function POST(request: Request): Promise<Response> {
  if (!(await isWorkshopAdmin(request))) return workshopUnauthorized();
  try {
    return Response.json(await renewSignupTokens(), { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    if (error instanceof InvalidInputError) {
      return Response.json({ error: error.message }, { status: 400, headers: { 'cache-control': 'no-store' } });
    }
    if (error instanceof PrepareInProgressError) {
      return Response.json({ error: 'Another prepare or renewal is running. Try again in a minute.' }, { status: 409, headers: { 'cache-control': 'no-store' } });
    }
    console.error('Signup renewal failed', error);
    return Response.json({ error: 'Renewing signup failed. Check that Pocket ID is running and try again.' }, { status: 500, headers: { 'cache-control': 'no-store' } });
  }
}
