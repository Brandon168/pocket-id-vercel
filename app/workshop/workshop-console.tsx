'use client';

import { useEffect, useState } from 'react';

type WorkshopSetup = {
  adminUsername: string;
  adminLoginUrl: string;
  joinUrl: string;
  capacity: number;
  expiresAt: string;
};

export function WorkshopConsole() {
  const [setup, setSetup] = useState<WorkshopSetup | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');

  async function load() {
    try {
      const response = await fetch(`${window.location.origin}/api/workshop`, { cache: 'no-store' });
      if (!response.ok) throw new Error('Could not load workshop setup');
      setSetup(await response.json() as WorkshopSetup | null);
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

  async function refreshAdminLogin() {
    setError('');
    const response = await fetch(`${window.location.origin}/api/workshop/admin-login`, { method: 'POST' });
    const result = await response.json() as WorkshopSetup & { error?: string };
    if (!response.ok) {
      setError(result.error ?? 'Could not create admin login');
      return;
    }
    setSetup(result);
  }

  async function copy(value: string, label: string) {
    await navigator.clipboard.writeText(value);
    setCopied(label);
    setTimeout(() => setCopied(''), 1_500);
  }

  if (loading) return <div className="panel loading">Loading workshop…</div>;

  if (!setup) {
    return (
      <div className="panel setup-panel">
        <div>
          <p className="eyebrow">One-click setup</p>
          <h2>Prepare this workshop</h2>
          <p className="muted">Creates the instructor admin, workshop group, OIDC client, and signup capacity for 1,000 attendees. Links expire after three days.</p>
        </div>
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={creating} onClick={createWorkshop}>
          {creating ? 'Preparing workshop…' : 'Prepare workshop'}
        </button>
        {creating && <p className="muted small">This takes about 90 seconds while Pocket ID creates ten signup pools serially.</p>}
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
          <span className="badge">Up to {setup.capacity.toLocaleString()}</span>
        </div>
        <div className="qr-frame"><img src={qrUrl} alt={`QR code for ${setup.joinUrl}`} /></div>
        <div className="url-box">
          <code>{setup.joinUrl}</code>
          <button className="secondary" onClick={() => copy(setup.joinUrl, 'join')}>{copied === 'join' ? 'Copied' : 'Copy URL'}</button>
        </div>
        <a className="download" href={`${qrUrl}&download=1`}>Download QR code</a>
        <p className="muted small">One stable URL distributes attendees across ten 100-use signup pools.</p>
      </section>

      <section className="panel admin-panel">
        <div>
          <p className="eyebrow">Instructor access</p>
          <h2>Start as admin</h2>
        </div>
        <dl>
          <div><dt>Username</dt><dd><code>{setup.adminUsername}</code></dd></div>
          <div><dt>Administration</dt><dd><code>/settings/admin</code></dd></div>
        </dl>
        <a className="primary link-button" href={setup.adminLoginUrl}>Open one-time admin login</a>
        <p className="muted small">Open this once in your instructor browser, then add a passkey at <strong>Settings → Account</strong>. Admin tools are under <strong>Settings → Administration</strong>.</p>
        <button className="secondary" onClick={refreshAdminLogin}>Create a new admin login</button>
        {error && <p className="error">{error}</p>}
      </section>
    </div>
  );
}
