import { isWorkshopAdmin, workshopUnauthorized } from '@/lib/workshop-auth';
import { estimateSetupSeconds, getWorkshopName, signupTokenCount } from '@/lib/workshop';
import { getWorkshopOptions, getWorkshopSetup, isPrepareInProgress } from '@/lib/workshop-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  if (!(await isWorkshopAdmin(request))) return workshopUnauthorized();
  try {
    const name = getWorkshopName();
    const [setup, options, preparing] = await Promise.all([
      getWorkshopSetup(name),
      getWorkshopOptions(name),
      isPrepareInProgress(name),
    ]);
    return Response.json(
      {
        setup,
        options,
        preparing: !setup && preparing,
        plan: {
          tokenCount: signupTokenCount(options.expectedAttendees),
          capacity: signupTokenCount(options.expectedAttendees) * 100,
          estimatedSeconds: estimateSetupSeconds(options.expectedAttendees, options.mode),
        },
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    console.error('Workshop status failed', error);
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
