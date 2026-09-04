import { claimSecrets, getSecrets } from '@/lib/secrets';
import { getWorkshopName } from '@/lib/workshop';
import { defaultWorkshopOptions, saveWorkshopOptions, type WorkshopOptions } from '@/lib/workshop-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const attendeeChoices = [50, 100, 250, 500, 1000];

function parseOptions(body: unknown): WorkshopOptions {
  const input = (body ?? {}) as Partial<Record<keyof WorkshopOptions, unknown>>;
  const attendees = Number(input.expectedAttendees);
  return {
    expectedAttendees: attendeeChoices.includes(attendees) ? attendees : defaultWorkshopOptions.expectedAttendees,
    requireEmail: input.requireEmail === true,
  };
}

// First-run claim. No authentication by design: this endpoint only works while
// the workshop has no secrets, and the deployer is expected to be the first
// visitor. After the single successful claim it always answers 409.
export async function POST(request: Request): Promise<Response> {
  try {
    const options = parseOptions(await request.json().catch(() => ({})));
    const claimed = await claimSecrets();
    if (claimed) {
      await saveWorkshopOptions(getWorkshopName(), options);
      return Response.json({ ...claimed, options }, { headers: { 'cache-control': 'no-store' } });
    }
    const existing = await getSecrets();
    return Response.json(
      { error: 'already_set_up', createdAt: existing?.createdAt ?? null },
      { status: 409, headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    console.error('First-run setup failed', error);
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
