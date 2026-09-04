import { claimSecrets, getSecrets } from '@/lib/secrets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// First-run claim. No authentication by design: this endpoint only works while
// the workshop has no secrets, and the deployer is expected to be the first
// visitor. After the single successful claim it always answers 409.
export async function POST(): Promise<Response> {
  try {
    const claimed = await claimSecrets();
    if (claimed) {
      return Response.json(claimed, { headers: { 'cache-control': 'no-store' } });
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
