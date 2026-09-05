'use client';

export type WorkshopMode = 'app' | 'vercel-team';

export type OptionsDraft = {
  expectedAttendees: number;
  requireEmail: boolean;
  mode: WorkshopMode;
  emailDomain: string;
  ownerEmail: string;
};

export const attendeeChoices = [50, 100, 250, 500, 1000];

export const defaultDraft: OptionsDraft = {
  expectedAttendees: 100,
  requireEmail: false,
  mode: 'app',
  emailDomain: '',
  ownerEmail: '',
};

export function OptionsForm({ value, onChange, disabled }: {
  value: OptionsDraft;
  onChange: (next: OptionsDraft) => void;
  disabled?: boolean;
}) {
  const set = (patch: Partial<OptionsDraft>) => onChange({ ...value, ...patch });
  return (
    <>
      <fieldset className="choice-group">
        <legend>What are attendees signing in to?</legend>
        <div className="mode-choices">
          <label className={`mode-choice${value.mode === 'app' ? ' selected' : ''}`}>
            <input type="radio" name="mode" value="app" checked={value.mode === 'app'} disabled={disabled} onChange={() => set({ mode: 'app' })} />
            <span className="mode-title">An app you are building</span>
            <span className="mode-detail">Pocket ID becomes the login provider for the room&apos;s project. Creates a public PKCE client that accepts any <code>*.vercel.app</code> callback.</span>
          </label>
          <label className={`mode-choice${value.mode === 'vercel-team' ? ' selected' : ''}`}>
            <input type="radio" name="mode" value="vercel-team" checked={value.mode === 'vercel-team'} disabled={disabled} onChange={() => set({ mode: 'vercel-team' })} />
            <span className="mode-title">A Vercel Enterprise team</span>
            <span className="mode-detail">Attendees get Vercel and v0 accounts from a passkey alone, through SSO + Directory Sync (Enterprise Managed Users). No signup, phone check, or invite emails.</span>
          </label>
        </div>
      </fieldset>

      {value.mode === 'vercel-team' && (
        <label className="field">
          <span className="field-label">Verified email domain of the Vercel team</span>
          <input
            className="search"
            type="text"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="workshop.example.com"
            value={value.emailDomain}
            required
            aria-required="true"
            disabled={disabled}
            onChange={(event) => set({ emailDomain: event.target.value })}
          />
          <span className="muted small">Use a dedicated subdomain of a domain your team already owns, for example <code>workshop.yourcompany.com</code>; you verify it later with one TXT record and it never has to point anywhere. Every attendee is registered as <code>username@{value.emailDomain || 'domain'}</code>, whatever they type; nothing is ever emailed. <code>*.vercel.app</code> hosts cannot be verified.</span>
        </label>
      )}

      {value.mode === 'vercel-team' && (
        <label className="field">
          <span className="field-label">Your Vercel login email <span className="muted">(recommended)</span></span>
          <input
            className="search"
            type="email"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="you@company.com"
            value={value.ownerEmail}
            disabled={disabled}
            onChange={(event) => set({ ownerEmail: event.target.value })}
          />
          <span className="muted small">Directory Sync matches people by email. With yours here, your existing account stays Owner and the SAML re-authentication Vercel asks for succeeds. Leave blank to create a separate managed Owner, <code>instructor@{value.emailDomain || 'domain'}</code>, instead.</span>
        </label>
      )}

      <fieldset className="choice-group">
        <legend>How many attendees?</legend>
        <div className="choices">
          {attendeeChoices.map((count) => (
            <label key={count} className={`choice${value.expectedAttendees === count ? ' selected' : ''}`}>
              <input
                type="radio"
                name="attendees"
                value={count}
                checked={value.expectedAttendees === count}
                disabled={disabled}
                onChange={() => set({ expectedAttendees: count })}
              />
              {count.toLocaleString()}
            </label>
          ))}
        </div>
        <p className="muted small">Sets signup capacity with 20% headroom. Larger rooms take a little longer to prepare.</p>
      </fieldset>

      {value.mode === 'app' && (
        <>
          <label className="acknowledge">
            <input type="checkbox" checked={value.requireEmail} disabled={disabled} onChange={(event) => set({ requireEmail: event.target.checked })} />
            Require an email address at signup
          </label>
          <p className="muted small">
            Username is always required; first and last name are always optional. Pocket ID has no setting to change that.
          </p>
        </>
      )}
    </>
  );
}
