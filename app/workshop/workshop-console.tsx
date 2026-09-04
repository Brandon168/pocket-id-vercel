'use client';

import { Fragment, useEffect, useState } from 'react';

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

type WorkshopStatus = {
  setup: WorkshopSetup | null;
  options: { expectedAttendees: number; requireEmail: boolean };
  plan: { tokenCount: number; capacity: number; estimatedSeconds: number };
};

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

  async function createWorkshop() {
    setCreating(true);
    setError('');
    try {
      const response = await fetch(`${window.location.origin}/api/workshop/setup`, { method: 'POST' });
      const result = await response.json() as WorkshopSetup & { error?: string };
      if (!response.ok) throw new Error(result.error ?? 'Workshop setup failed');
      setSetup(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreating(false);
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
    return (
      <div className="panel setup-panel">
        <div>
          <p className="eyebrow">One-click setup</p>
          <h2>Prepare this workshop</h2>
          <p className="muted">
            Creates the instructor admin, workshop group, OIDC client, and signup capacity for{' '}
            {capacity.toLocaleString()} attendees ({attendees.toLocaleString()} expected plus headroom).
            {status?.options.requireEmail ? ' Attendees must provide an email.' : ' Email is optional at signup.'}
            {' '}Links expire after three days.
          </p>
        </div>
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={creating} onClick={createWorkshop}>
          {creating ? 'Preparing workshop…' : 'Prepare workshop'}
        </button>
        {creating && (
          <p className="muted small">
            First run also starts Pocket ID (up to a minute). Provisioning itself takes about {seconds} seconds.
          </p>
        )}
      </div>
    );
  }

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
        </p>
        {adminLogin && (
          <div className="secret">
            <p className="secret-label">{adminLogin.popupBlocked ? 'Your browser blocked the new tab. Open this link instead:' : 'Opened in a new tab. If it did not appear:'}</p>
            <div className="url-box">
              <code>{adminLogin.loginUrl}</code>
              <a className="secondary link-button" href={adminLogin.loginUrl} target="_blank" rel="noreferrer">Open</a>
            </div>
            <p className="muted small">Valid for one hour, works once. Click the button again for a new one.</p>
          </div>
        )}
        {error && <p className="error">{error}</p>}
      </section>

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
          <li><strong>Signed out, or on another device, with no passkey?</strong> Find them below and click <strong>Login code</strong>. A one-time code appears under their row; send them the link or have them type the code. Works once, lasts an hour.</li>
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
              {attendeePage.attendees.map((attendee) => {
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
