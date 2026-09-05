import { isWorkshopAdmin, workshopUnauthorized } from '@/lib/workshop-auth';
import { getWorkshopName, InvalidOptionsError, parseWorkshopOptions } from '@/lib/workshop';
import { getWorkshopSetup, saveWorkshopOptions } from '@/lib/workshop-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Lets the instructor change what /setup chose, but only until the workshop
// has been prepared: after that Pocket ID already holds the clients, groups,
// and tokens those options produced.
export async function PUT(request: Request): Promise<Response> {
  if (!(await isWorkshopAdmin(request))) return workshopUnauthorized();
  try {
    const name = getWorkshopName();
    if (await getWorkshopSetup(name)) {
      return Response.json(
        { error: 'The workshop is already prepared. Delete the project and Neon resource to start over with different options.' },
        { status: 409, headers: { 'cache-control': 'no-store' } },
      );
    }
    const options = parseWorkshopOptions(await request.json().catch(() => ({})));
    await saveWorkshopOptions(name, options);
    return Response.json(options, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    if (error instanceof InvalidOptionsError) {
      return Response.json({ error: error.message }, { status: 400, headers: { 'cache-control': 'no-store' } });
    }
    console.error('Workshop options update failed', error);
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
