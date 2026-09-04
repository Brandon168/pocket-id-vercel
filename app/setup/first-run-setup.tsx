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

const attendeeChoices = [50, 100, 250, 500, 1000];

export function FirstRunSetup() {
  const [expectedAttendees, setExpectedAttendees] = useState(100);
  const [requireEmail, setRequireEmail] = useState(false);
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
      const response = await fetch(`${window.location.origin}/api/setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedAttendees, requireEmail }),
      });
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
          <p className="eyebrow">Save this now</p>
          <h2>Your instructor password</h2>
          <p className="muted">
            Shown once and not stored anywhere you can read it later. Copy it into your password manager
            before leaving this page.
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

        <div className="callout">
          <p>
            <strong>How to sign in:</strong> the next page shows your browser&apos;s sign-in prompt.
            Leave the username empty (or type anything) and paste this password. Only the password is checked.
          </p>
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
        <h2>Set up this workshop</h2>
        <p className="muted">
          Two quick choices, then one click generates the secrets this workshop needs and stores them in its
          Neon database. You will get an instructor password to save.
        </p>
      </div>

      <fieldset className="choice-group">
        <legend>How many attendees?</legend>
        <div className="choices">
          {attendeeChoices.map((count) => (
            <label key={count} className={`choice${expectedAttendees === count ? ' selected' : ''}`}>
              <input
                type="radio"
                name="attendees"
                value={count}
                checked={expectedAttendees === count}
                onChange={() => setExpectedAttendees(count)}
              />
              {count.toLocaleString()}
            </label>
          ))}
        </div>
        <p className="muted small">Sets signup capacity with 20% headroom. Larger rooms take a little longer to prepare.</p>
      </fieldset>

      <label className="acknowledge">
        <input type="checkbox" checked={requireEmail} onChange={(event) => setRequireEmail(event.target.checked)} />
        Require an email address at signup
      </label>
      <p className="muted small">
        Username is always required; first and last name are always optional. Pocket ID has no setting to change that.
      </p>

      {error && <p className="error">{error}</p>}
      <button className="primary" disabled={working} onClick={claim}>
        {working ? 'Generating…' : 'Set up this workshop'}
      </button>
    </div>
  );
}
