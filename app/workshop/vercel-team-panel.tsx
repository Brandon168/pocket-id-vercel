'use client';

import { useEffect, useState } from 'react';

export type VercelTeamStatus = {
  issuer: string;
  discoveryUrl: string;
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  teamSlug: string | null;
  signInUrl: string;
  emailDomain: string;
  memberGroup: string;
  ownerGroup: string;
  workshopGroup: string;
  instructorEmail: string | null;
  scim: { endpoint: string; lastSyncedAt: string | null; lastAttemptAt: string | null; lastError: string | null } | null;
  sandboxRunning: boolean;
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${window.location.origin}${path}`, { cache: 'no-store', ...init });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error ?? `Request failed (${response.status})`);
  return result;
}

const json = (body: unknown): RequestInit => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export function VercelTeamPanel({ copy, copied }: { copy: (value: string, label: string) => void; copied: string }) {
  const [status, setStatus] = useState<VercelTeamStatus | null>(null);
  const [error, setError] = useState<{ at: 'load' | 'client' | 'scim'; message: string } | null>(null);
  const [busy, setBusy] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [editingCallback, setEditingCallback] = useState(false);
  const [callbackDraft, setCallbackDraft] = useState('');
  const [editingSlug, setEditingSlug] = useState(false);
  const [slugDraft, setSlugDraft] = useState('');
  const [editingEmail, setEditingEmail] = useState(false);
  const [emailDraft, setEmailDraft] = useState('');
  const [scimEndpoint, setScimEndpoint] = useState('');
  const [scimToken, setScimToken] = useState('');
  const [scimOpen, setScimOpen] = useState(false);

  function apply(result: VercelTeamStatus) {
    setStatus(result);
    setCallbackDraft(result.callbackUrl);
    setSlugDraft(result.teamSlug ?? '');
    setEmailDraft(result.instructorEmail ?? '');
  }

  useEffect(() => {
    api<VercelTeamStatus>('/api/workshop/vercel')
      .then((result) => { apply(result); if (!result.scim) setScimOpen(true); })
      .catch((cause) => setError({ at: 'load', message: cause instanceof Error ? cause.message : String(cause) }));
  }, []);

  async function run(label: string, at: 'client' | 'scim', action: () => Promise<VercelTeamStatus>) {
    setBusy(label);
    setError(null);
    try {
      apply(await action());
    } catch (cause) {
      // A failed push still leaves the connection in place; show the latest state.
      api<VercelTeamStatus>('/api/workshop/vercel').then(apply).catch(() => undefined);
      setError({ at, message: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setBusy('');
    }
  }

  const saveCallback = () => run('callback', 'client', async () => {
    const result = await api<VercelTeamStatus>('/api/workshop/vercel', { method: 'PATCH', ...json({ callbackUrl: callbackDraft }) });
    setEditingCallback(false);
    return result;
  });

  const saveSlug = () => run('slug', 'client', async () => {
    const result = await api<VercelTeamStatus>('/api/workshop/vercel', { method: 'PATCH', ...json({ teamSlug: slugDraft }) });
    setEditingSlug(false);
    return result;
  });

  const saveEmail = () => run('email', 'client', async () => {
    const result = await api<VercelTeamStatus>('/api/workshop/vercel', { method: 'PATCH', ...json({ instructorEmail: emailDraft }) });
    setEditingEmail(false);
    return result;
  });

  const rotateSecret = () => {
    if (!window.confirm('Issue a new client secret? The old one stops working and you must update it in Vercel.')) return;
    void run('rotate', 'client', async () => {
      const result = await api<VercelTeamStatus>('/api/workshop/vercel', { method: 'PATCH', ...json({ rotateSecret: true }) });
      setShowSecret(true);
      return result;
    });
  };

  const connectScim = () => run('scim', 'scim', async () => {
    const result = await api<VercelTeamStatus>('/api/workshop/vercel', { method: 'POST', ...json({ endpoint: scimEndpoint, token: scimToken }) });
    setScimToken('');
    setScimOpen(false);
    return result;
  });

  const syncNow = () => run('sync', 'scim', () => api<VercelTeamStatus>('/api/workshop/vercel/sync', { method: 'POST' }));

  if (!status) {
    return (
      <section className="panel vercel-panel">
        <div>
          <p className="eyebrow">Vercel team</p>
          <h2>Connect this workshop to Vercel</h2>
        </div>
        {error ? <p className="error">{error.message}</p> : <p className="muted">Loading connection…</p>}
      </section>
    );
  }

  const lastSynced = status.scim?.lastSyncedAt ? new Date(status.scim.lastSyncedAt).toLocaleString() : null;
  const lastAttempt = status.scim?.lastAttemptAt ? new Date(status.scim.lastAttemptAt).toLocaleString() : null;
  const pushFailed = Boolean(status.scim?.lastError);
  const pinned = !status.callbackUrl.includes('*');
  const copyButton = (value: string, label: string) => (
    <button className="tiny" onClick={() => copy(value, label)}>{copied === label ? 'Copied' : 'Copy'}</button>
  );

  return (
    <section className="panel vercel-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Vercel team</p>
          <h2>Connect this workshop to Vercel</h2>
        </div>
        <span className={`badge${status.scim && !pushFailed ? '' : ' pending'}`}>
          {!status.scim && 'Directory Sync not connected'}
          {status.scim && pushFailed && 'Directory Sync · last push failed'}
          {status.scim && !pushFailed && (lastSynced ? `Directory Sync · last push ${lastSynced}` : 'Directory Sync connected')}
        </span>
      </div>

      <p className="muted">
        As an Owner of the Vercel team, open <strong>Settings → Security &amp; Privacy → Authentication and User Provisioning</strong>.
        The team needs the domain <code>{status.emailDomain}</code> verified and Enterprise Managed Users available.
      </p>

      <h3 className="step">1. SAML → Configure → <em>Custom OIDC</em></h3>
      <p className="muted small">Provider name <code>Pocket ID</code>. Vercel shows a login redirect URL; Pocket ID already accepts it. Paste these three values:</p>
      <dl>
        <div><dt>Discovery endpoint</dt><dd><code>{status.discoveryUrl}</code>{copyButton(status.discoveryUrl, 'discovery')}</dd></div>
        <div><dt>Client ID</dt><dd><code>{status.clientId}</code>{copyButton(status.clientId, 'clientid')}</dd></div>
        <div>
          <dt>Client secret</dt>
          <dd>
            <code>{showSecret ? status.clientSecret : '•'.repeat(status.clientSecret.length)}</code>
            <button className="tiny" onClick={() => setShowSecret((value) => !value)}>{showSecret ? 'Hide' : 'Show'}</button>
            {copyButton(status.clientSecret, 'secret')}
          </dd>
        </div>
        <div>
          <dt>Accepted redirect URL</dt>
          <dd>
            {editingCallback ? (
              <>
                <input className="search inline" value={callbackDraft} onChange={(event) => setCallbackDraft(event.target.value)} spellCheck={false} autoCapitalize="none" />
                <button className="tiny" disabled={busy === 'callback'} onClick={saveCallback}>{busy === 'callback' ? 'Saving…' : 'Save'}</button>
                <button className="tiny" onClick={() => { setEditingCallback(false); setCallbackDraft(status.callbackUrl); setError(null); }}>Cancel</button>
              </>
            ) : (
              <>
                <code>{status.callbackUrl}</code>
                <button className="tiny" onClick={() => setEditingCallback(true)}>{pinned ? 'Change' : 'Pin exact URL'}</button>
              </>
            )}
          </dd>
        </div>
        <div>
          <dt>Team slug</dt>
          <dd>
            {editingSlug ? (
              <>
                <input className="search inline" value={slugDraft} onChange={(event) => setSlugDraft(event.target.value)} placeholder="my-workshop-team" spellCheck={false} autoCapitalize="none" />
                <button className="tiny" disabled={busy === 'slug'} onClick={saveSlug}>{busy === 'slug' ? 'Saving…' : 'Save'}</button>
                <button className="tiny" onClick={() => { setEditingSlug(false); setSlugDraft(status.teamSlug ?? ''); setError(null); }}>Cancel</button>
              </>
            ) : (
              <>
                <code>{status.teamSlug ?? 'not set'}</code>
                <button className="tiny" onClick={() => setEditingSlug(true)}>{status.teamSlug ? 'Change' : 'Set'}</button>
              </>
            )}
          </dd>
        </div>
        <div>
          <dt>Your account as Owner</dt>
          <dd>
            {editingEmail ? (
              <>
                <input className="search inline" type="email" value={emailDraft} onChange={(event) => setEmailDraft(event.target.value)} placeholder={`instructor@${status.emailDomain}`} spellCheck={false} autoCapitalize="none" />
                <button className="tiny" disabled={busy === 'email'} onClick={saveEmail}>{busy === 'email' ? 'Saving…' : 'Save'}</button>
                <button className="tiny" onClick={() => { setEditingEmail(false); setEmailDraft(status.instructorEmail ?? ''); setError(null); }}>Cancel</button>
              </>
            ) : (
              <>
                <code>{status.instructorEmail ?? (status.sandboxRunning ? 'not set' : 'unknown while Pocket ID is idle')}</code>
                <button className="tiny" onClick={() => setEditingEmail(true)}>Change</button>
              </>
            )}
          </dd>
        </div>
      </dl>
      {error?.at === 'client' && <p className="error">{error.message}</p>}
      <p className="muted small">
        {pinned
          ? <>Only this exact redirect URL is accepted; use Change to go back to the wildcard <code>https://auth.vercel.com/sso/oidc/*/callback</code> if Vercel shows a different one.</>
          : <>The wildcard matches every team&apos;s <code>auth.vercel.com/sso/oidc/…/callback</code>; pin the exact URL from the dialog if you prefer.</>}
        {' '}Setting the team slug gives attendees a <strong>Vercel</strong> tile in Pocket ID that opens <code>{status.signInUrl}</code>.
        {' '}<button className="linkish" disabled={busy === 'rotate'} onClick={rotateSecret}>Rotate secret</button> if it ever leaks.
      </p>

      <h3 className="step">2. Directory Sync → Configure → <em>Custom SCIM</em></h3>
      {status.scim && !scimOpen ? (
        <div className="scim-connected">
          <dl>
            <div><dt>SCIM endpoint</dt><dd><code>{status.scim.endpoint}</code></dd></div>
            <div><dt>Last successful push</dt><dd>{lastSynced ?? (status.sandboxRunning ? 'Not yet' : 'Unknown while Pocket ID is idle')}</dd></div>
            {pushFailed && <div><dt>Last attempt</dt><dd><span className="pill warn">Failed{lastAttempt ? ` · ${lastAttempt}` : ''}</span></dd></div>}
          </dl>
          {pushFailed && !error && <p className="error">{status.scim.lastError}</p>}
          {error?.at === 'scim' && <p className="error">{error.message}</p>}
          <div className="inline-actions">
            <button className="secondary" disabled={busy === 'sync'} onClick={syncNow}>{busy === 'sync' ? 'Pushing…' : 'Sync now'}</button>
            <button className="secondary" onClick={() => { setScimEndpoint(status.scim?.endpoint ?? ''); setScimOpen(true); setError(null); }}>Replace endpoint or token</button>
          </div>
          <p className="muted small">
            Every signup is pushed to Vercel automatically about 15 seconds later (bursts share one push), and Pocket ID re-syncs hourly.
            <strong> Sync now</strong> is for after you fix an attendee by hand.
          </p>
        </div>
      ) : (
        <div className="scim-form">
          <p className="muted small">Directory provider <code>Pocket ID</code>, authentication <strong>Bearer token</strong>. Vercel then shows an endpoint and a token; paste both here.</p>
          <label className="field">
            <span className="field-label">SCIM endpoint</span>
            <input className="search" value={scimEndpoint} onChange={(event) => setScimEndpoint(event.target.value)} placeholder="https://auth.vercel.com/scim/v2.0/…" spellCheck={false} autoCapitalize="none" />
          </label>
          <label className="field">
            <span className="field-label">Bearer token</span>
            <input className="search" type="password" value={scimToken} onChange={(event) => setScimToken(event.target.value)} placeholder="se_…" autoComplete="off" />
          </label>
          {error?.at === 'scim' && <p className="error">{error.message}</p>}
          <div className="inline-actions">
            <button className="primary" disabled={busy === 'scim' || !scimEndpoint || !scimToken} onClick={connectScim}>{busy === 'scim' ? 'Connecting and pushing…' : 'Connect and push now'}</button>
            {status.scim && <button className="secondary" onClick={() => { setScimOpen(false); setError(null); }}>Cancel</button>}
          </div>
          <p className="muted small">After the first push succeeds, Vercel lets you save Directory Sync and map groups. The token is stored in Pocket ID only.</p>
        </div>
      )}

      <h3 className="step">3. Map groups, enable EMU, sign in</h3>
      <p className="muted small">
        Map <code>{status.workshopGroup}</code> to <strong>Member</strong> (or an Access Group). Attendees are also placed in <code>{status.memberGroup}</code>, which
        Vercel treats as the Member role even with no mapping, so nobody lands as a viewer. Then enable Enterprise Managed Users.
        Attendees sign in at <code>{status.signInUrl}</code>{copyButton(status.signInUrl, 'signin')}.
      </p>
      <div className="callout">
        <p>
          <strong>You will not lock yourself out.</strong> The first sync rewrites every member&apos;s role, including yours. Your <code>instructor</code> identity is
          pushed too, in <code>{status.ownerGroup}</code>, which Vercel maps to <strong>Owner</strong>. Its email decides which account that is:
          <code> instructor@{status.emailDomain}</code> (default) becomes a new managed Owner you sign in to through Pocket ID, right for an EMU team.
          Change it to your own Vercel login email if you want your existing account to stay Owner on a team without EMU.
        </p>
      </div>

      {error?.at === 'load' && <p className="error">{error.message}</p>}
    </section>
  );
}
