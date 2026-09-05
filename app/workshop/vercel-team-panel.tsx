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
  workshopGroup: string;
  scim: { endpoint: string; lastSyncedAt: string | null } | null;
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
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [editingCallback, setEditingCallback] = useState(false);
  const [callbackDraft, setCallbackDraft] = useState('');
  const [editingSlug, setEditingSlug] = useState(false);
  const [slugDraft, setSlugDraft] = useState('');
  const [scimEndpoint, setScimEndpoint] = useState('');
  const [scimToken, setScimToken] = useState('');
  const [scimOpen, setScimOpen] = useState(false);

  function apply(result: VercelTeamStatus) {
    setStatus(result);
    setCallbackDraft(result.callbackUrl);
    setSlugDraft(result.teamSlug ?? '');
  }

  useEffect(() => {
    api<VercelTeamStatus>('/api/workshop/vercel')
      .then((result) => { apply(result); if (!result.scim) setScimOpen(true); })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);

  async function run(label: string, action: () => Promise<VercelTeamStatus>) {
    setBusy(label);
    setError('');
    try {
      apply(await action());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy('');
    }
  }

  const saveCallback = () => run('callback', async () => {
    const result = await api<VercelTeamStatus>('/api/workshop/vercel', { method: 'PATCH', ...json({ callbackUrl: callbackDraft }) });
    setEditingCallback(false);
    return result;
  });

  const saveSlug = () => run('slug', async () => {
    const result = await api<VercelTeamStatus>('/api/workshop/vercel', { method: 'PATCH', ...json({ teamSlug: slugDraft }) });
    setEditingSlug(false);
    return result;
  });

  const rotateSecret = () => {
    if (!window.confirm('Issue a new client secret? The old one stops working and you must update it in Vercel.')) return;
    void run('rotate', async () => {
      const result = await api<VercelTeamStatus>('/api/workshop/vercel', { method: 'PATCH', ...json({ rotateSecret: true }) });
      setShowSecret(true);
      return result;
    });
  };

  const connectScim = () => run('scim', async () => {
    const result = await api<VercelTeamStatus>('/api/workshop/vercel', { method: 'POST', ...json({ endpoint: scimEndpoint, token: scimToken }) });
    setScimToken('');
    setScimOpen(false);
    return result;
  });

  const syncNow = () => run('sync', () => api<VercelTeamStatus>('/api/workshop/vercel/sync', { method: 'POST' }));

  if (!status) {
    return (
      <section className="panel vercel-panel">
        <div>
          <p className="eyebrow">Vercel team</p>
          <h2>Connect this workshop to Vercel</h2>
        </div>
        {error ? <p className="error">{error}</p> : <p className="muted">Loading connection…</p>}
      </section>
    );
  }

  const lastSynced = status.scim?.lastSyncedAt ? new Date(status.scim.lastSyncedAt).toLocaleString() : null;
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
        <span className={`badge${status.scim ? '' : ' pending'}`}>
          {status.scim ? (lastSynced ? `Directory Sync · last push ${lastSynced}` : 'Directory Sync connected') : 'Directory Sync not connected'}
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
            <code>{showSecret ? status.clientSecret : '•'.repeat(24)}</code>
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
                <button className="tiny" onClick={() => { setEditingCallback(false); setCallbackDraft(status.callbackUrl); }}>Cancel</button>
              </>
            ) : (
              <>
                <code>{status.callbackUrl}</code>
                <button className="tiny" onClick={() => setEditingCallback(true)}>Pin exact URL</button>
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
                <button className="tiny" onClick={() => { setEditingSlug(false); setSlugDraft(status.teamSlug ?? ''); }}>Cancel</button>
              </>
            ) : (
              <>
                <code>{status.teamSlug ?? 'not set'}</code>
                <button className="tiny" onClick={() => setEditingSlug(true)}>{status.teamSlug ? 'Change' : 'Set'}</button>
              </>
            )}
          </dd>
        </div>
      </dl>
      <p className="muted small">
        The wildcard matches every team&apos;s <code>auth.vercel.com/sso/oidc/…/callback</code>; pin the exact URL from the dialog if you prefer.
        Setting the team slug gives attendees a <strong>Vercel</strong> tile in Pocket ID that opens <code>{status.signInUrl}</code>.
        {' '}<button className="linkish" disabled={busy === 'rotate'} onClick={rotateSecret}>Rotate secret</button> if it ever leaks.
      </p>

      <h3 className="step">2. Directory Sync → Configure → <em>Custom SCIM</em></h3>
      {status.scim && !scimOpen ? (
        <div className="scim-connected">
          <dl>
            <div><dt>SCIM endpoint</dt><dd><code>{status.scim.endpoint}</code></dd></div>
            <div><dt>Last push</dt><dd>{lastSynced ?? (status.sandboxRunning ? 'Not yet' : 'Unknown while Pocket ID is idle')}</dd></div>
          </dl>
          <div className="inline-actions">
            <button className="secondary" disabled={busy === 'sync'} onClick={syncNow}>{busy === 'sync' ? 'Pushing…' : 'Sync now'}</button>
            <button className="secondary" onClick={() => { setScimEndpoint(status.scim?.endpoint ?? ''); setScimOpen(true); }}>Replace endpoint or token</button>
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
          <div className="inline-actions">
            <button className="primary" disabled={busy === 'scim' || !scimEndpoint || !scimToken} onClick={connectScim}>{busy === 'scim' ? 'Connecting and pushing…' : 'Connect and push now'}</button>
            {status.scim && <button className="secondary" onClick={() => setScimOpen(false)}>Cancel</button>}
          </div>
          <p className="muted small">After the first push succeeds, Vercel lets you save Directory Sync and map groups. The token is stored in Pocket ID only.</p>
        </div>
      )}

      <h3 className="step">3. Map groups, enable EMU, sign in</h3>
      <p className="muted small">
        Map <code>{status.workshopGroup}</code> to <strong>Member</strong> (or an Access Group). Attendees are also placed in <code>{status.memberGroup}</code>, which
        Vercel treats as the Member role even with no mapping, so nobody lands as a viewer. Keep yourself an Owner before confirming the first sync,
        then enable Enterprise Managed Users. Attendees sign in at <code>{status.signInUrl}</code>{copyButton(status.signInUrl, 'signin')}.
      </p>

      {error && <p className="error">{error}</p>}
    </section>
  );
}
