import { isWorkshopAdmin, workshopUnauthorized } from '@/lib/workshop-auth';
import {
  connectVercelDirectorySync,
  getVercelTeamStatus,
  rotateVercelClientSecret,
  updateInstructorEmail,
  updateVercelClient,
} from '@/lib/workshop';
import { InvalidInputError } from '@/lib/workshop';

export const runtime = 'nodejs';
export const maxDuration = 120;
export const dynamic = 'force-dynamic';

const noStore = { headers: { 'cache-control': 'no-store' } };

function failure(error: unknown, context: string): Response {
  if (error instanceof InvalidInputError) {
    return Response.json({ error: error.message }, { status: 400, ...noStore });
  }
  console.error(context, error);
  return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500, ...noStore });
}

// Everything the instructor pastes into Vercel, plus SCIM status.
export async function GET(request: Request): Promise<Response> {
  if (!(await isWorkshopAdmin(request))) return workshopUnauthorized();
  try {
    return Response.json(await getVercelTeamStatus(new URL(request.url).origin), noStore);
  } catch (error) {
    return failure(error, 'Vercel team status failed');
  }
}

// Connect (or reconnect) Directory Sync: { endpoint, token }. Runs a first sync.
export async function POST(request: Request): Promise<Response> {
  if (!(await isWorkshopAdmin(request))) return workshopUnauthorized();
  try {
    const body = (await request.json().catch(() => ({}))) as { endpoint?: unknown; token?: unknown };
    if (typeof body.endpoint !== 'string' || typeof body.token !== 'string') {
      return Response.json({ error: 'endpoint and token are required' }, { status: 400, ...noStore });
    }
    await connectVercelDirectorySync(body.endpoint, body.token);
    return Response.json(await getVercelTeamStatus(new URL(request.url).origin), noStore);
  } catch (error) {
    return failure(error, 'Directory Sync connection failed');
  }
}

// Adjust the connection: { callbackUrl } to pin Vercel's exact redirect URL,
// { teamSlug } for the launch URL and sign-in link (empty string clears it),
// { instructorEmail } to choose which Vercel account stays Owner, or
// { rotateSecret: true } to issue a fresh client secret.
export async function PATCH(request: Request): Promise<Response> {
  if (!(await isWorkshopAdmin(request))) return workshopUnauthorized();
  try {
    const body = (await request.json().catch(() => ({}))) as {
      callbackUrl?: unknown; teamSlug?: unknown; rotateSecret?: unknown; instructorEmail?: unknown;
    };
    const patch: { callbackUrl?: string; teamSlug?: string | null } = {};
    if (typeof body.callbackUrl === 'string') patch.callbackUrl = body.callbackUrl;
    if (typeof body.teamSlug === 'string' || body.teamSlug === null) patch.teamSlug = body.teamSlug;
    if (Object.keys(patch).length) await updateVercelClient(patch);
    if (typeof body.instructorEmail === 'string') await updateInstructorEmail(body.instructorEmail);
    if (body.rotateSecret === true) await rotateVercelClientSecret();
    return Response.json(await getVercelTeamStatus(new URL(request.url).origin), noStore);
  } catch (error) {
    return failure(error, 'Vercel SSO client update failed');
  }
}
