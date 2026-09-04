'use client';

import { useState } from 'react';

type Claimed = {
  adminSecret: string;
  staticApiKey: string;
  createdAt: string;
};

type Conflict = {
  error: 'already_set_up';
  createdAt: string | null;
};

export function FirstRunSetup() {
  const [claimed, setClaimed] = useState<Claimed | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);

  async function claim() {
    setWorking(true);
    setError('');
    try {
      const response = await fetch(`${window.location.origin}/api/setup`, { method: 'POST' });
      const result = await response.json() as Claimed | Conflict | { error?: string };
      if (response.status === 409 && 'error' in result && result.error === 'already_set_up') {
        setConflict(result as Conflict);
        return;
      }
      if (!response.ok) throw new Error(('error' in result && result.error) || 'Setup failed');
      setClaimed(result as Claimed);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(false);
    }
  }

  async function copy(value: string, label: string) {
    await navigator.clipboard.writeText(value);
    setCopied(label);
    setTimeout(() => setCopied(''), 1_500);
  }

  if (conflict) {
    const when = conflict.createdAt ? new Date(conflict.createdAt).toLocaleString() : 'earlier';
    return (
      <div className="panel setup-panel">
        <div>
          <p className="eyebrow">Already set up</p>
          <h2>Someone completed setup {when}</h2>
          <p className="muted">
            If that was you in another tab, open the instructor console. If it was not you, treat this
            deployment as compromised: delete the Vercel project and its Neon resource, then deploy again.
          </p>
        </div>
        <a className="primary link-button" href="/workshop">Open instructor console</a>
      </div>
    );
  }

  if (claimed) {
    return (
      <div className="panel setup-panel">
        <div>
          <p className="eyebrow">Save these now</p>
          <h2>Your instructor credentials</h2>
          <p className="muted">
            These are shown once and are not stored anywhere you can read them later. Copy the password
            into your password manager before leaving this page.
          </p>
        </div>

        <div className="secret">
          <p className="secret-label">Instructor password <span className="muted small">— for <code>/workshop</code>; any username</span></p>
          <div className="url-box">
            <code>{claimed.adminSecret}</code>
            <button className="secondary" onClick={() => copy(claimed.adminSecret, 'password')}>
              {copied === 'password' ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>

        <div className="secret">
          <p className="secret-label">Pocket ID API key <span className="muted small">— only needed for <code>setup.sh</code>; the console does not use it</span></p>
          <div className="url-box">
            <code>{claimed.staticApiKey}</code>
            <button className="secondary" onClick={() => copy(claimed.staticApiKey, 'apikey')}>
              {copied === 'apikey' ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>

        <label className="acknowledge">
          <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
          I have saved the instructor password
        </label>

        <a
          className={`primary link-button${acknowledged ? '' : ' disabled'}`}
          href="/workshop"
          aria-disabled={!acknowledged}
          onClick={(event) => { if (!acknowledged) event.preventDefault(); }}
        >
          Continue to instructor console
        </a>
        <p className="muted small">
          Lost it later? Set a <code>WORKSHOP_ADMIN_SECRET</code> environment variable on the Vercel project and redeploy.
        </p>
      </div>
    );
  }

  return (
    <div className="panel setup-panel">
      <div>
        <p className="eyebrow">First run</p>
        <h2>Generate workshop secrets</h2>
        <p className="muted">
          Creates the Pocket ID encryption key, its API key, and a random instructor password, and stores them
          in this workshop&apos;s Neon database. Nothing else is needed from you.
        </p>
      </div>
      {error && <p className="error">{error}</p>}
      <button className="primary" disabled={working} onClick={claim}>
        {working ? 'Generating…' : 'Set up this workshop'}
      </button>
    </div>
  );
}
