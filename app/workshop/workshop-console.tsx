'use client';

import { Fragment, useEffect, useState } from 'react';
import { OptionsForm, type OptionsDraft, type WorkshopMode } from './options-form';
import { VercelTeamPanel } from './vercel-team-panel';

type WorkshopSetup = {
  adminUsername: string;
  adminLoginUrl: string;
  joinUrl: string;
  capacity: number;
  expiresAt: string;
};

type SignupProgress = { used: number; capacity: number; sandboxRunning: boolean };
type AttendeeLogin = { username: string; displayName: string; code: string; loginUrl: string; codeEntryUrl: string; ttl: string };
type Attendee = { id: string; username: string; displayName: string; email: string | null; disabled: boolean; hasPasskey: boolean | null };
type AttendeePage = { idle: false; attendees: Attendee[]; page: number; totalPages: number; totalItems: number };
type AttendeesIdle = { idle: true };

type WorkshopOptions = { expectedAttendees: number; requireEmail: boolean; mode: WorkshopMode; emailDomain: string | null };

type WorkshopStatus = {
  setup: WorkshopSetup | null;
  options: WorkshopOptions;
  preparing: boolean;
  plan: { tokenCount: number; capacity: number; estimatedSeconds: number };
};

function toDraft(options: WorkshopOptions): OptionsDraft {
  return { ...options, emailDomain: options.emailDomain ?? '' };
}

export function WorkshopConsole() {
  const [setup, setSetup] = useState<WorkshopSetup | null>(null);
  const [status, setStatus] = useState<WorkshopStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');

  async function load() {
    try {
      const response = await fetch(`${window.location.origin}/api/workshop`, { cache: 'no-store' });
      if (!response.ok) throw new Error('Could not load workshop setup');
      const result = await response.json() as WorkshopStatus;
      setStatus(result);
      setSetup(result.setup);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  // A Prepare started from /setup (or another tab) shows here as progress;
  // poll until the setup row appears or the lease lapses.
  const preparingElsewhere = Boolean(status?.preparing && !setup && !creating);
  useEffect(() => {
    if (!preparingElsewhere) return;
    const timer = setInterval(() => { void load(); }, 5_000);
    return () => clearInterval(timer);
  }, [preparingElsewhere]);

  async function createWorkshop() {
    setCreating(true);
    setError('');
    try {
      const response = await fetch(`${window.location.origin}/api/workshop/setup`, { method: 'POST' });
      const result = await response.json() as WorkshopSetup & { error?: string; inProgress?: boolean };
      if (response.status === 409 && result.inProgress) {
        await load();
        return;
      }
      if (!response.ok) throw new Error(result.error ?? 'Workshop setup failed');
      setSetup(result);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreating(false);
    }
  }

  // Options stay editable until the workshop is prepared.
  const [editingOptions, setEditingOptions] = useState(false);
  const [draft, setDraft] = useState<OptionsDraft | null>(null);
  const [savingOptions, setSavingOptions] = useState(false);

  async function saveOptions() {
    if (!draft) return;
    setSavingOptions(true);
    setError('');
    try {
      const response = await fetch(`${window.location.origin}/api/workshop/options`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(draft),
      });
      const result = await response.json() as WorkshopOptions & { error?: string };
      if (!response.ok) throw new Error(result.error ?? 'Could not save options');
      setEditingOptions(false);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSavingOptions(false);
    }
  }

  const [adminLogin, setAdminLogin] = useState<{ loginUrl: string; popupBlocked: boolean } | null>(null);
  const [openingAdmin, setOpeningAdmin] = useState(false);

  async function openAdmin() {
    setError('');
    setOpeningAdmin(true);
    // Open the tab synchronously so popup blockers attribute it to the click,
    // then point it at the freshly minted link.
    const tab = window.open('', '_blank');
    try {
      const response = await fetch(`${window.location.origin}/api/workshop/admin-login`, { method: 'POST' });
      const result = await response.json() as { loginUrl?: string; error?: string };
      if (!response.ok || !result.loginUrl) throw new Error(result.error ?? 'Could not create admin login');
      if (tab) {
        tab.location.href = result.loginUrl;
        setAdminLogin({ loginUrl: result.loginUrl, popupBlocked: false });
      } else {
        setAdminLogin({ loginUrl: result.loginUrl, popupBlocked: true });
      }
    } catch (cause) {
      tab?.close();
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setOpeningAdmin(false);
    }
  }

  const [progress, setProgress] = useState<SignupProgress | null>(null);
  // Inline result keyed by attendee id so it renders under the row that was clicked.
  const [helpResult, setHelpResult] = useState<{ attendeeId: string; login: AttendeeLogin } | null>(null);
  const [helpError, setHelpError] = useState<{ attendeeId: string; message: string } | null>(null);
  const [helpingId, setHelpingId] = useState('');
  const [search, setSearch] = useState('');
  const [attendeePage, setAttendeePage] = useState<AttendeePage | null>(null);
  const [attendeesIdle, setAttendeesIdle] = useState(false);
  const [attendeesLoading, setAttendeesLoading] = useState(false);
  const [attendeesError, setAttendeesError] = useState('');
  const [onlyWithoutPasskey, setOnlyWithoutPasskey] = useState(false);

  useEffect(() => {
    if (!setup) return;
    let cancelled = false;
    async function poll() {
      try {
        const response = await fetch(`${window.location.origin}/api/workshop/signups`, { cache: 'no-store' });
        if (response.ok && !cancelled) setProgress(await response.json() as SignupProgress);
      } catch {
        // Progress is decorative; ignore transient failures.
      }
    }
    void poll();
    const timer = setInterval(poll, 60_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [setup]);

  async function loadAttendees(page = 1, term = search, wake = false) {
    setAttendeesLoading(true);
    setAttendeesError('');
    try {
      const params = new URLSearchParams({ page: String(page) });
      if (term.trim()) params.set('search', term.trim());
      if (wake) params.set('wake', '1');
      const response = await fetch(`${window.location.origin}/api/workshop/attendees?${params}`, { cache: 'no-store' });
      const result = await response.json() as (AttendeePage | AttendeesIdle) & { error?: string };
      if (!response.ok) throw new Error(result.error ?? 'Could not load attendees');
      if (result.idle) {
        setAttendeesIdle(true);
        return;
      }
      setAttendeesIdle(false);
      setAttendeePage(result);
    } catch (cause) {
      setAttendeesError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAttendeesLoading(false);
    }
  }

  // Initial load once setup exists; never wakes an idle Sandbox by itself.
  useEffect(() => {
    if (!setup) return;
    void loadAttendees(1, '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setup]);

  // Debounced search, only while a list is showing.
  useEffect(() => {
    if (!setup || attendeesIdle || !attendeePage) return;
    const timer = setTimeout(() => { void loadAttendees(1, search); }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  async function issueLoginLink(attendee: Attendee) {
    setHelpingId(attendee.id);
    setHelpError(null);
    setHelpResult(null);
    try {
      const response = await fetch(`${window.location.origin}/api/workshop/login-link`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: attendee.id }),
      });
      const result = await response.json() as AttendeeLogin & { error?: string };
      if (!response.ok) throw new Error(result.error ?? 'Could not create login code');
      setHelpResult({ attendeeId: attendee.id, login: result });
    } catch (cause) {
      setHelpError({ attendeeId: attendee.id, message: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setHelpingId('');
    }
  }

  async function copy(value: string, label: string) {
    await navigator.clipboard.writeText(value);
    setCopied(label);
    setTimeout(() => setCopied(''), 1_500);
  }

  if (loading) return <div className="panel loading">Loading workshop…</div>;

  if (!setup) {
    const capacity = status?.plan.capacity ?? 0;
    const attendees = status?.options.expectedAttendees ?? 0;
    const seconds = status?.plan.estimatedSeconds ?? 0;
    const options = status?.options;
    const vercelTeam = options?.mode === 'vercel-team';
    if (preparingElsewhere) {
      return (
        <div className="panel setup-panel">
          <div>
            <p className="eyebrow">Almost there</p>
            <h2>Preparing your workshop</h2>
          </div>
          <div className="progress running">
            <span className="spinner" aria-hidden="true" />
            <p>
              Starting Pocket ID (about a minute), then creating the instructor admin, groups, client, and signup capacity for{' '}
              {capacity.toLocaleString()} attendees. This page updates by itself when it finishes.
            </p>
          </div>
        </div>
      );
    }
    if (editingOptions && draft) {
      return (
        <div className="panel setup-panel">
          <div>
            <p className="eyebrow">Before you prepare</p>
            <h2>Change workshop options</h2>
          </div>
          <OptionsForm value={draft} onChange={setDraft} disabled={savingOptions} />
          {error && <p className="error">{error}</p>}
          <div className="inline-actions">
            <button className="primary" disabled={savingOptions} onClick={saveOptions}>{savingOptions ? 'Saving…' : 'Save options'}</button>
            <button className="secondary" disabled={savingOptions} onClick={() => { setEditingOptions(false); setError(''); }}>Cancel</button>
          </div>
        </div>
      );
    }
    return (
      <div className="panel setup-panel">
        <div>
          <p className="eyebrow">One-click setup</p>
          <h2>Prepare this workshop</h2>
          <p className="muted">
            {vercelTeam ? (
              <>
                Creates the instructor admin, the <code>workshop</code> and <code>vercel-role-member</code> groups, a confidential
                <code> vercel-sso</code> client with its secret, and signup capacity for {capacity.toLocaleString()} attendees
                ({attendees.toLocaleString()} expected plus headroom). Every attendee is registered as{' '}
                <code>username@{options?.emailDomain}</code>.
              </>
            ) : (
              <>
                Creates the instructor admin, workshop group, the <code>workshop-app</code> OIDC client, and signup capacity for{' '}
                {capacity.toLocaleString()} attendees ({attendees.toLocaleString()} expected plus headroom).
                {options?.requireEmail ? ' Attendees must provide an email.' : ' Email is optional at signup.'}
              </>
            )}
            {' '}Links expire after three days.
          </p>
        </div>
        <dl>
          <div><dt>Attendees sign in to</dt><dd>{vercelTeam ? 'A Vercel Enterprise team (SSO + Directory Sync)' : 'An app you are building'}</dd></div>
          {vercelTeam && <div><dt>Email domain</dt><dd><code>{options?.emailDomain}</code></dd></div>}
          <div><dt>Room size</dt><dd>{attendees.toLocaleString()} expected · capacity {capacity.toLocaleString()}</dd></div>
        </dl>
        {error && <p className="error">{error}</p>}
        <div className="inline-actions">
          <button className="primary" disabled={creating} onClick={createWorkshop}>
            {creating ? 'Preparing workshop…' : 'Prepare workshop'}
          </button>
          <button className="secondary" disabled={creating || !options} onClick={() => { if (options) { setDraft(toDraft(options)); setEditingOptions(true); } }}>
            Change options
          </button>
        </div>
        {creating && (
          <p className="muted small">
            First run also starts Pocket ID (up to a minute). Provisioning itself takes about {seconds} seconds.
          </p>
        )}
        <p className="muted small">Options lock once the workshop is prepared. To change them afterwards, delete the project and Neon resource and deploy again.</p>
      </div>
    );
  }

  const vercelTeam = status?.options.mode === 'vercel-team';
  const qrUrl = `/api/workshop/qr?url=${encodeURIComponent(setup.joinUrl)}`;
  return (
    <div className="console-grid">
      <section className="panel join-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Attendee signup</p>
            <h2>Put this on your slide</h2>
          </div>
          <span className="badge">
            {progress?.sandboxRunning
              ? `${progress.used.toLocaleString()} of ${setup.capacity.toLocaleString()} signed up`
              : `Up to ${setup.capacity.toLocaleString()}`}
          </span>
        </div>
        <div className="qr-frame"><img src={qrUrl} alt={`QR code for ${setup.joinUrl}`} /></div>
        <div className="url-box">
          <code>{setup.joinUrl}</code>
          <button className="secondary" onClick={() => copy(setup.joinUrl, 'join')}>{copied === 'join' ? 'Copied' : 'Copy URL'}</button>
        </div>
        <a className="download" href={`${qrUrl}&download=1`}>Download QR code</a>
        <p className="muted small">
          One stable URL distributes attendees across {status?.plan.tokenCount ?? 1} signup pool{(status?.plan.tokenCount ?? 1) === 1 ? '' : 's'} of 100 uses each.
          {vercelTeam && <> Email is assigned automatically as <code>username@{status?.options.emailDomain}</code>; attendees can leave it blank.</>}
        </p>
      </section>

      <section className="panel admin-panel">
        <div>
          <p className="eyebrow">Instructor access</p>
          <h2>Start as admin</h2>
        </div>
        <dl>
          <div><dt>Username</dt><dd><code>{setup.adminUsername}</code></dd></div>
          <div><dt>Admin: users</dt><dd><a href="/settings/admin/users" target="_blank" rel="noreferrer">/settings/admin/users</a></dd></div>
          <div><dt>Admin: OIDC clients</dt><dd><a href="/settings/admin/oidc-clients" target="_blank" rel="noreferrer">/settings/admin/oidc-clients</a></dd></div>
        </dl>
        <button className="primary" disabled={openingAdmin} onClick={openAdmin}>
          {openingAdmin ? 'Signing you in…' : 'Open Pocket ID admin in a new tab'}
        </button>
        <p className="muted small">
          Each click creates a fresh one-time sign-in for <code>{setup.adminUsername}</code> and opens the admin
          Users page. No code to type. Once there, add a passkey under <strong>Settings → Account</strong> so you
          can sign in normally later. The <strong>Administration</strong> section is in the Settings sidebar.
          You will also see an admin named <code>static-api-user-…</code>: that is this console&apos;s service account. Leave it.
        </p>
        {adminLogin?.popupBlocked && (
          <div className="secret">
            <p className="secret-label">Your browser blocked the new tab. Open this link instead:</p>
            <div className="url-box">
              <code>{adminLogin.loginUrl}</code>
              <a className="secondary link-button" href={adminLogin.loginUrl} target="_blank" rel="noreferrer">Open</a>
            </div>
            <p className="muted small">Valid for one hour, works once. Click the button again for a new one.</p>
          </div>
        )}
        {adminLogin && !adminLogin.popupBlocked && (
          <p className="muted small">Opened in a new tab. Click the button again if you need another sign-in.</p>
        )}
        {error && <p className="error">{error}</p>}
      </section>

      {vercelTeam && <VercelTeamPanel copy={copy} copied={copied} />}

      {!vercelTeam && (
        <section className="panel integration-panel">
          <div>
            <p className="eyebrow">Your app</p>
            <h2>Point your app at Pocket ID</h2>
          </div>
          <dl>
            <div><dt>Issuer</dt><dd><code>{window.location.origin}</code><button className="tiny" onClick={() => copy(window.location.origin, 'issuer')}>{copied === 'issuer' ? 'Copied' : 'Copy'}</button></dd></div>
            <div><dt>Discovery</dt><dd><code>{`${window.location.origin}/.well-known/openid-configuration`}</code></dd></div>
            <div><dt>Client ID</dt><dd><code>workshop-app</code></dd></div>
            <div><dt>Client type</dt><dd>Public, PKCE required, no secret</dd></div>
            <div><dt>Callback</dt><dd><code>https://*.vercel.app/api/auth/callback/pocket-id</code></dd></div>
          </dl>
          <p className="muted small">
            Any Vercel deployment, including previews, can complete sign-in. Edit the client in Pocket ID admin under
            <strong> OIDC Clients</strong> if your app uses a different callback path.
          </p>
        </section>
      )}

      <section className="panel help-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">During the workshop</p>
            <h2>Attendees</h2>
          </div>
          {attendeePage && <span className="badge">{attendeePage.totalItems.toLocaleString()} registered</span>}
        </div>
        <ol className="tips">
          <li><strong>No Touch ID / Windows Hello?</strong> At the passkey step they can pick &quot;use a phone&quot; and scan the QR with a personal phone.</li>
          <li><strong>Passkeys blocked entirely?</strong> <strong>Skip for now</strong> keeps them signed in for 30 days on that device.</li>
          <li><strong>Signed out, or on another device, with no passkey?</strong> Ask for their username (it is on their Settings → Account page if they are still signed in anywhere), find them below, and click <strong>Login code</strong>. Send the link or have them type the code. Works once, lasts an hour.</li>
          <li><strong>Testing the QR yourself?</strong> A device that is already signed in to Pocket ID (yours, or an attendee re-scanning) gets a choice to continue to the account or sign out and register someone new.</li>
          <li><strong>Tip for your signup slide:</strong> ask attendees to use <code>firstname-lastname</code> as their username. Name and email are optional in Pocket ID, so the username is how you will find people.</li>
          {vercelTeam && (
            <li><strong>Vercel account not showing up?</strong> Signups are pushed to Vercel about 15 seconds after they happen. If someone is still missing after a minute, click <strong>Sync now</strong> above, then have them sign in at the sign-in link shown in the Vercel team panel.</li>
          )}
        </ol>

        <div className="list-toolbar">
          <input
            className="search"
            type="search"
            placeholder="Search by username, name, or email"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            disabled={attendeesIdle}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
          <label className="filter-toggle">
            <input type="checkbox" checked={onlyWithoutPasskey} disabled={attendeesIdle} onChange={(event) => setOnlyWithoutPasskey(event.target.checked)} />
            No passkey only
          </label>
          <button
            className="secondary"
            disabled={attendeesLoading || attendeesIdle}
            onClick={() => loadAttendees(attendeePage?.page ?? 1, search)}
          >
            {attendeesLoading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
        {attendeesError && <p className="error">{attendeesError}</p>}

        {attendeesIdle && (
          <div className="idle-notice">
            <p className="muted">Pocket ID is idle, so the attendee list is not loaded. Nothing here runs in the background.</p>
            <button className="secondary" disabled={attendeesLoading} onClick={() => loadAttendees(1, search, true)}>
              {attendeesLoading ? 'Waking Pocket ID…' : 'Wake Pocket ID and load attendees'}
            </button>
          </div>
        )}

        {!attendeesIdle && attendeePage && attendeePage.attendees.length === 0 && !attendeesLoading && (
          <p className="muted small">{search ? 'No attendees match that search.' : 'No attendees have registered yet.'}</p>
        )}
        {!attendeesIdle && attendeePage && attendeePage.attendees.length > 0 && (
          <table className={`attendees${attendeesLoading ? ' stale' : ''}`}>
            <thead>
              <tr><th>Username</th><th>Name</th><th>Email</th><th>Passkey</th><th></th></tr>
            </thead>
            <tbody>
              {attendeePage.attendees.filter((attendee) => !onlyWithoutPasskey || attendee.hasPasskey !== true).map((attendee) => {
                const login = helpResult?.attendeeId === attendee.id ? helpResult.login : null;
                const rowError = helpError?.attendeeId === attendee.id ? helpError.message : '';
                const expanded = Boolean(login || rowError);
                return (
                  <Fragment key={attendee.id}>
                    <tr className={`${attendee.hasPasskey === false ? 'needs-help' : ''}${expanded ? ' expanded' : ''}`}>
                      <td><code>{attendee.username}</code></td>
                      <td>{attendee.displayName !== attendee.username ? attendee.displayName : <span className="muted">—</span>}</td>
                      <td>{attendee.email ?? <span className="muted">—</span>}</td>
                      <td>
                        {attendee.hasPasskey === true && <span className="pill ok">Yes</span>}
                        {attendee.hasPasskey === false && <span className="pill warn">None</span>}
                        {attendee.hasPasskey === null && <span className="pill">Unknown</span>}
                      </td>
                      <td className="row-action">
                        {expanded ? (
                          <button className="secondary" onClick={() => { setHelpResult(null); setHelpError(null); }}>Close</button>
                        ) : (
                          <button className="secondary" disabled={helpingId === attendee.id} onClick={() => issueLoginLink(attendee)}>
                            {helpingId === attendee.id ? 'Creating…' : 'Login code'}
                          </button>
                        )}
                      </td>
                    </tr>
                    {expanded && (
                      <tr className="detail-row">
                        <td colSpan={5}>
                          {rowError && <p className="error">{rowError}</p>}
                          {login && (
                            <div className="code-inline">
                              <div>
                                <p className="big-code">{login.code}</p>
                                <p className="muted small">
                                  For <strong>{login.displayName}</strong>. Send them the link, or have them open{' '}
                                  <code>{login.codeEntryUrl.replace(/^https?:\/\//, '')}</code> and type the code. Valid one hour, works once.
                                </p>
                              </div>
                              <div className="code-actions">
                                <button className="secondary" onClick={() => copy(login.code, `code-${attendee.id}`)}>{copied === `code-${attendee.id}` ? 'Copied' : 'Copy code'}</button>
                                <button className="secondary" onClick={() => copy(login.loginUrl, `link-${attendee.id}`)}>{copied === `link-${attendee.id}` ? 'Copied' : 'Copy link'}</button>
                              </div>
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
        {!attendeesIdle && attendeePage && attendeePage.totalPages > 1 && (
          <div className="pager">
            <button className="secondary" disabled={attendeePage.page <= 1 || attendeesLoading} onClick={() => loadAttendees(attendeePage.page - 1)}>Previous</button>
            <span className="muted small">Page {attendeePage.page} of {attendeePage.totalPages}</span>
            <button className="secondary" disabled={attendeePage.page >= attendeePage.totalPages || attendeesLoading} onClick={() => loadAttendees(attendeePage.page + 1)}>Next</button>
          </div>
        )}
        <p className="muted small">The list only updates when you refresh. Admin accounts are hidden.</p>
      </section>
    </div>
  );
}
