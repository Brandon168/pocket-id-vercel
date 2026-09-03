import type { Metadata } from 'next';
import { WorkshopConsole } from './workshop-console';
import './workshop.css';

export const metadata: Metadata = {
  title: 'Workshop setup · Pocket ID',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default function WorkshopPage() {
  return (
    <main>
      <header>
        <div className="mark">P</div>
        <div>
          <p className="eyebrow">Pocket ID on Vercel</p>
          <h1>Workshop setup</h1>
          <p className="lede">One signup link for the room. One admin login for the instructor.</p>
        </div>
      </header>
      <WorkshopConsole />
      <footer>Workshop identity is retained in Neon until you delete the workshop resources.</footer>
    </main>
  );
}
