import { isWorkshopAdmin, workshopUnauthorized } from '@/lib/workshop-auth';
import { getPassportStatus, InvalidInputError } from '@/lib/workshop';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const noStore = { headers: { 'cache-control': 'no-store' } };

export async function GET(request: Request): Promise<Response> {
  if (!(await isWorkshopAdmin(request))) return workshopUnauthorized();
  try {
    return Response.json(await getPassportStatus(new URL(request.url).origin), noStore);
  } catch (error) {
    if (error instanceof InvalidInputError) {
      return Response.json({ error: error.message }, { status: 400, ...noStore });
    }
    return Response.json({ error: 'Could not load Passport credentials. Try again.' }, { status: 500, ...noStore });
  }
}
