'use client';

import { useEffect, useState } from 'react';
import type { PassportStatus } from '@/lib/workshop';

export function PassportPanel({ copy, copied }: {
  copy: (value: string, label: string) => Promise<void>;
  copied: string;
}) {
  const [connection, setConnection] = useState<PassportStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showSecret, setShowSecret] = useState(false);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/workshop/passport', { cache: 'no-store' });
      if (!response.ok) throw new Error('Could not load Passport credentials. Try again.');
      setConnection(await response.json() as PassportStatus | null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load Passport credentials.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  return (
    <section className="panel integration-panel">
      <div>
        <p className="eyebrow">Protect workshop apps</p>
        <h2>Connect Vercel Passport</h2>
        <p className="muted">Pocket ID credentials are prepared here. A Vercel Enterprise team Owner completes the connection in Vercel.</p>
      </div>
      {loading && <p className="muted" role="status">Loading Passport credentials…</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {!loading && !connection && !error && <p className="muted">Prepare the workshop to create its Passport credentials.</p>}
      {!loading && (error || !connection) && <button className="secondary" onClick={load}>Retry</button>}
      {connection && (
        <>
          <h3 className="step">1. Create an OAuth Connect application</h3>
          <p className="muted small">In Vercel&apos;s Passport settings, create a Connect application, choose <strong>OAuth → Your own credentials</strong>, then paste the issuer into <strong>Server URL</strong> and select <strong>Discover</strong>. Enter the client ID and secret below. Use the <code>openid</code> scope; add <code>profile</code> and <code>email</code> if your app needs them.</p>
          <dl>
            {[
              ['Issuer / Server URL', connection.issuer, 'issuer'],
              ['Discovery URL', connection.discoveryUrl, 'discovery'],
              ['Client ID', connection.clientId, 'client'],
              ['Callback URL', connection.callbackUrl, 'callback'],
            ].map(([label, value, key]) => (
              <div key={key}><dt>{label}</dt><dd><code>{value}</code><button className="tiny" aria-label={`Copy ${label}`} onClick={() => copy(value, `passport-${key}`)}>{copied === `passport-${key}` ? 'Copied' : 'Copy'}</button></dd></div>
            ))}
            <div><dt>Client secret</dt><dd>
              <code>{showSecret ? connection.clientSecret : '••••••••••••••••'}</code>
              <button className="tiny" aria-label={showSecret ? 'Hide Passport secret' : 'Show Passport secret'} onClick={() => setShowSecret(!showSecret)}>{showSecret ? 'Hide' : 'Show'}</button>
              <button className="tiny" aria-label="Copy Passport secret" onClick={() => copy(connection.clientSecret, 'passport-secret')}>{copied === 'passport-secret' ? 'Copied' : 'Copy'}</button>
            </dd></div>
          </dl>
          <h3 className="step">2. Assign Passport to the workshop apps</h3>
          <p className="muted small">Enable Passport on each app project and select the Connect application. A team default applies to new projects; assign existing projects separately. Keep this Pocket ID project publicly reachable so it can handle sign-in.</p>
          <h3 className="step">3. Test an attendee on a protected deployment</h3>
          <p className="muted small">Open the signup link on the attendee&apos;s laptop, create a passkey, then visit the protected app in a separate browser session. Confirm sign-in and the identity your app receives. Passport protects deployed apps; real Pocket ID sign-in inside the v0 editor sandbox still needs separate verification. Passport does not create Vercel or v0 accounts.</p>
          <a className="download" href="https://vercel.com/docs/passport/set-up-identity-provider" target="_blank" rel="noreferrer">Vercel Passport setup guide</a>
        </>
      )}
    </section>
  );
}
