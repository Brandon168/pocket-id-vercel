import { claimSecrets, getSecrets, instructorCookieHeader } from '@/lib/secrets';
import { getWorkshopName, InvalidOptionsError, parseWorkshopOptions } from '@/lib/workshop';
import { saveWorkshopOptions } from '@/lib/workshop-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// First-run claim. No authentication by design: this endpoint only works while
// the workshop has no secrets, and the deployer is expected to be the first
// visitor. After the single successful claim it always answers 409.
export async function POST(request: Request): Promise<Response> {
  try {
    const options = parseWorkshopOptions(await request.json().catch(() => ({})));
    const claimed = await claimSecrets();
    if (claimed) {
      await saveWorkshopOptions(getWorkshopName(), options);
      // The deployer's browser becomes the instructor session; no Basic-auth
      // prompt stands between them and the console.
      return Response.json(
        { ...claimed, options },
        { headers: { 'cache-control': 'no-store', 'set-cookie': await instructorCookieHeader() } },
      );
    }
    const existing = await getSecrets();
    return Response.json(
      { error: 'already_set_up', createdAt: existing?.createdAt ?? null },
      { status: 409, headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    if (error instanceof InvalidOptionsError) {
      return Response.json({ error: error.message }, { status: 400, headers: { 'cache-control': 'no-store' } });
    }
    console.error('First-run setup failed', error);
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
