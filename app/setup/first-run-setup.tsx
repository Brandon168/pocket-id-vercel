'use client';

import { useState } from 'react';
import { defaultDraft, OptionsForm, type OptionsDraft } from '../workshop/options-form';

type Claimed = {
  adminSecret: string;
  staticApiKey: string;
  createdAt: string;
};

type Conflict = {
  error: 'already_set_up';
  createdAt: string | null;
};

type Prepare = { state: 'running' } | { state: 'done'; joinUrl: string } | { state: 'failed'; message: string };

export function FirstRunSetup() {
  const [draft, setDraft] = useState<OptionsDraft>(defaultDraft);
  const [claimed, setClaimed] = useState<Claimed | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [prepare, setPrepare] = useState<Prepare | null>(null);

  // Starts Pocket ID and provisions the workshop while the instructor saves
  // the password. The claim response set the session cookie, so this call is
  // already authenticated.
  async function prepareWorkshop() {
    setPrepare({ state: 'running' });
    try {
      const response = await fetch(`${window.location.origin}/api/workshop/setup`, { method: 'POST' });
      const result = await response.json() as { joinUrl?: string; error?: string };
      if (!response.ok || !result.joinUrl) throw new Error(result.error ?? 'Preparing the workshop failed');
      setPrepare({ state: 'done', joinUrl: result.joinUrl });
    } catch (cause) {
      setPrepare({ state: 'failed', message: cause instanceof Error ? cause.message : String(cause) });
    }
  }

  async function claim() {
    if (draft.mode === 'vercel-team' && !draft.emailDomain.trim()) {
      setError('Enter the email domain your Vercel team has verified, for example workshop.example.com');
      return;
    }
    setWorking(true);
    setError('');
    try {
      const response = await fetch(`${window.location.origin}/api/setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(draft),
      });
      const result = await response.json() as Claimed | Conflict | { error?: string };
      if (response.status === 409 && 'error' in result && result.error === 'already_set_up') {
        setConflict(result as Conflict);
        return;
      }
      if (!response.ok) throw new Error(('error' in result && result.error) || 'Setup failed');
      setClaimed(result as Claimed);
      void prepareWorkshop();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(false);
    }
  }

  async function copy(value: string, label: string) {
    await navigator.clipboard.writeText(value);
    setCopied(label);
    if (label === 'password') setAcknowledged(true);
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
          <p className="eyebrow">Save this now</p>
          <h2>Your instructor password</h2>
          <p className="muted">
            Shown once and not stored anywhere you can read it later. Copy it into your password manager.
            This browser is already signed in as the instructor; the password is for any other device.
          </p>
        </div>

        <div className="secret">
          <p className="secret-label">Instructor password</p>
          <div className="url-box">
            <code>{claimed.adminSecret}</code>
            <button className="secondary" onClick={() => copy(claimed.adminSecret, 'password')}>
              {copied === 'password' ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>

        <div className={`progress ${prepare?.state ?? 'running'}`}>
          {(!prepare || prepare.state === 'running') && (
            <>
              <span className="spinner" aria-hidden="true" />
              <p>
                <strong>Preparing your workshop in the background.</strong> Starting Pocket ID (about a minute), then creating the instructor
                admin, groups, client, and signup capacity. You can keep this page open or continue; the console shows progress too.
              </p>
            </>
          )}
          {prepare?.state === 'done' && (
            <p>
              <strong>Workshop ready.</strong> Attendees sign up at <code>{prepare.joinUrl}</code>. The console has the QR code.
            </p>
          )}
          {prepare?.state === 'failed' && (
            <p>
              <strong>Preparing did not finish:</strong> {prepare.message} Open the console and click <strong>Prepare workshop</strong> to retry;
              every step is safe to repeat.
            </p>
          )}
        </div>

        <details className="advanced">
          <summary>Pocket ID API key (only for <code>setup.sh</code>)</summary>
          <div className="url-box">
            <code>{claimed.staticApiKey}</code>
            <button className="secondary" onClick={() => copy(claimed.staticApiKey, 'apikey')}>
              {copied === 'apikey' ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="muted small">The instructor console does not need this. Skip it unless you plan to run the CLI provisioner.</p>
        </details>

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
          Open instructor console
        </a>
        <p className="muted small">
          Lost the password later? Set a <code>WORKSHOP_ADMIN_SECRET</code> environment variable on the Vercel project and redeploy.
        </p>
      </div>
    );
  }

  return (
    <div className="panel setup-panel">
      <div>
        <p className="eyebrow">First run</p>
        <h2>Set up this workshop</h2>
        <p className="muted">
          A few quick choices, then one click generates the secrets this workshop needs and stores them in its
          Neon database. You will get an instructor password to save. You can still change these choices from
          the console until you prepare the workshop.
        </p>
      </div>

      <OptionsForm value={draft} onChange={setDraft} disabled={working} />

      {error && <p className="error">{error}</p>}
      <button className="primary" disabled={working} onClick={claim}>
        {working ? 'Generating…' : 'Set up this workshop'}
      </button>
    </div>
  );
}
