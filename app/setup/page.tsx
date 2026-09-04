import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { isSetupComplete } from '@/lib/secrets';
import { FirstRunSetup } from './first-run-setup';
import '../workshop/workshop.css';

export const metadata: Metadata = {
  title: 'First-run setup · Pocket ID',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function SetupPage() {
  // The proxy already redirects here; this is the second lock on the door.
  if (await isSetupComplete()) redirect('/workshop');

  return (
    <main>
      <header>
        <div className="mark">P</div>
        <div>
          <p className="eyebrow">Pocket ID on Vercel</p>
          <h1>Finish setting up</h1>
          <p className="lede">One click generates this workshop&apos;s secrets. You will see them exactly once.</p>
        </div>
      </header>
      <FirstRunSetup />
      <footer>This screen is only shown before the first setup. It will not appear again for this workshop.</footer>
    </main>
  );
}
