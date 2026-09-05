import { neon, type NeonQueryFunction } from '@neondatabase/serverless';

export type WorkshopSetup = {
  adminId: string;
  adminUsername: string;
  adminLoginUrl: string;
  joinUrl: string;
  signupTokens: string[];
  capacity: number;
  expiresAt: Date;
};

// What attendees sign in to once they have a passkey.
//   app          — an application the room is building; Pocket ID issues a
//                  public PKCE client (`workshop-app`).
//   vercel-team  — a Vercel Enterprise team via SSO + Directory Sync
//                  (Enterprise Managed Users); Pocket ID issues a confidential
//                  client (`vercel-sso`) and pushes users over SCIM.
export type WorkshopMode = 'app' | 'vercel-team';

export type WorkshopOptions = {
  expectedAttendees: number;
  requireEmail: boolean;
  mode: WorkshopMode;
  // Required in vercel-team mode: every attendee's email is forced to this
  // domain because Enterprise Managed Users only accepts a verified domain.
  emailDomain: string | null;
};

export const defaultWorkshopOptions: WorkshopOptions = {
  expectedAttendees: 100,
  requireEmail: false,
  mode: 'app',
  emailDomain: null,
};

// Pocket ID side of the Vercel connection. The secret is stored so the
// instructor can paste it into Vercel's SSO dialog whenever they get there;
// it lives in the same Neon database as every other workshop secret.
export type VercelConnection = {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  // vercel.com/<slug>; optional, used for the client launch URL and sign-in link.
  teamSlug: string | null;
  scimProviderId: string | null;
  scimEndpoint: string | null;
  // Outcome of the most recent push attempt (manual or automatic).
  lastSyncError: string | null;
  lastSyncAttemptAt: Date | null;
  updatedAt: Date;
};

let sqlClient: NeonQueryFunction<false, false> | null = null;

function workshopSql() {
  if (sqlClient) return sqlClient;
  const connectionString = process.env.CONTROLLER_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error('CONTROLLER_DATABASE_URL or DATABASE_URL is required');
  sqlClient = neon(connectionString);
  return sqlClient;
}

async function initializeWorkshopSetup(): Promise<void> {
  const sql = workshopSql();
  await sql`
    CREATE TABLE IF NOT EXISTS pocket_id_workshop_setup (
      name text PRIMARY KEY,
      admin_id text NOT NULL,
      admin_username text NOT NULL,
      admin_login_url text NOT NULL,
      join_url text NOT NULL,
      signup_tokens jsonb NOT NULL,
      capacity integer NOT NULL,
      expires_at timestamptz NOT NULL,
      next_token bigint NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `;
}

function mapSetup(row: Record<string, unknown>): WorkshopSetup {
  return {
    adminId: String(row.admin_id),
    adminUsername: String(row.admin_username),
    adminLoginUrl: String(row.admin_login_url),
    joinUrl: String(row.join_url),
    signupTokens: row.signup_tokens as string[],
    capacity: Number(row.capacity),
    expiresAt: new Date(String(row.expires_at)),
  };
}

export async function getWorkshopSetup(name: string): Promise<WorkshopSetup | null> {
  await initializeWorkshopSetup();
  const rows = await workshopSql()`SELECT * FROM pocket_id_workshop_setup WHERE name = ${name}`;
  return rows.length ? mapSetup(rows[0] as Record<string, unknown>) : null;
}

export async function saveWorkshopSetup(name: string, setup: WorkshopSetup): Promise<void> {
  await initializeWorkshopSetup();
  await workshopSql()`
    INSERT INTO pocket_id_workshop_setup (
      name, admin_id, admin_username, admin_login_url, join_url,
      signup_tokens, capacity, expires_at
    ) VALUES (
      ${name}, ${setup.adminId}, ${setup.adminUsername}, ${setup.adminLoginUrl}, ${setup.joinUrl},
      ${JSON.stringify(setup.signupTokens)}::jsonb, ${setup.capacity}, ${setup.expiresAt.toISOString()}
    )
    ON CONFLICT (name) DO UPDATE SET
      admin_login_url = EXCLUDED.admin_login_url,
      updated_at = now()
  `;
}

export async function updateAdminLoginUrl(name: string, adminLoginUrl: string): Promise<void> {
  await initializeWorkshopSetup();
  await workshopSql()`
    UPDATE pocket_id_workshop_setup
    SET admin_login_url = ${adminLoginUrl}, updated_at = now()
    WHERE name = ${name}
  `;
}

async function initializeWorkshopOptions(): Promise<void> {
  const sql = workshopSql();
  await sql`
    CREATE TABLE IF NOT EXISTS pocket_id_workshop_options (
      name text PRIMARY KEY,
      expected_attendees integer NOT NULL,
      require_email boolean NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  // Columns added after the first release; older workshops keep 'app' mode.
  await sql`ALTER TABLE pocket_id_workshop_options ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'app'`;
  await sql`ALTER TABLE pocket_id_workshop_options ADD COLUMN IF NOT EXISTS email_domain text`;
  await sql`ALTER TABLE pocket_id_workshop_options ADD COLUMN IF NOT EXISTS prepare_started_at timestamptz`;
}

// Prepare runs from /setup automatically and from the console on demand.
// A short lease keeps two callers from provisioning at the same time and lets
// the console show "preparing" instead of a second button.
const prepareLeaseMinutes = 5;

export async function acquirePrepareLease(name: string): Promise<boolean> {
  await initializeWorkshopOptions();
  const rows = await workshopSql()`
    INSERT INTO pocket_id_workshop_options (name, expected_attendees, require_email, mode, email_domain, prepare_started_at)
    VALUES (${name}, ${defaultWorkshopOptions.expectedAttendees}, ${defaultWorkshopOptions.requireEmail}, ${defaultWorkshopOptions.mode}, ${defaultWorkshopOptions.emailDomain}, now())
    ON CONFLICT (name) DO UPDATE SET prepare_started_at = now()
    WHERE pocket_id_workshop_options.prepare_started_at IS NULL
       OR pocket_id_workshop_options.prepare_started_at < now() - make_interval(mins => ${prepareLeaseMinutes})
    RETURNING name
  `;
  return rows.length > 0;
}

export async function releasePrepareLease(name: string): Promise<void> {
  await workshopSql()`UPDATE pocket_id_workshop_options SET prepare_started_at = NULL WHERE name = ${name}`;
}

export async function isPrepareInProgress(name: string): Promise<boolean> {
  await initializeWorkshopOptions();
  const rows = await workshopSql()`
    SELECT 1 FROM pocket_id_workshop_options
    WHERE name = ${name}
      AND prepare_started_at IS NOT NULL
      AND prepare_started_at >= now() - make_interval(mins => ${prepareLeaseMinutes})
  `;
  return rows.length > 0;
}

export async function getWorkshopOptions(name: string): Promise<WorkshopOptions> {
  await initializeWorkshopOptions();
  const rows = await workshopSql()`SELECT * FROM pocket_id_workshop_options WHERE name = ${name}`;
  if (!rows.length) return defaultWorkshopOptions;
  const row = rows[0] as Record<string, unknown>;
  return {
    expectedAttendees: Number(row.expected_attendees),
    requireEmail: Boolean(row.require_email),
    mode: row.mode === 'vercel-team' ? 'vercel-team' : 'app',
    emailDomain: row.email_domain ? String(row.email_domain) : null,
  };
}

export async function saveWorkshopOptions(name: string, options: WorkshopOptions): Promise<void> {
  await initializeWorkshopOptions();
  await workshopSql()`
    INSERT INTO pocket_id_workshop_options (name, expected_attendees, require_email, mode, email_domain)
    VALUES (${name}, ${options.expectedAttendees}, ${options.requireEmail}, ${options.mode}, ${options.emailDomain})
    ON CONFLICT (name) DO UPDATE SET
      expected_attendees = EXCLUDED.expected_attendees,
      require_email = EXCLUDED.require_email,
      mode = EXCLUDED.mode,
      email_domain = EXCLUDED.email_domain,
      updated_at = now()
  `;
}

export async function takeNextSignupToken(name: string): Promise<string | null> {
  await initializeWorkshopSetup();
  const rows = await workshopSql()`
    UPDATE pocket_id_workshop_setup
    SET next_token = next_token + 1
    WHERE name = ${name} AND expires_at > now() AND jsonb_array_length(signup_tokens) > 0
    RETURNING signup_tokens, next_token
  `;
  if (!rows.length) return null;
  const row = rows[0] as Record<string, unknown>;
  const tokens = row.signup_tokens as string[];
  return tokens[(Number(row.next_token) - 1) % tokens.length] ?? null;
}

async function initializeVercelConnection(): Promise<void> {
  await workshopSql()`
    CREATE TABLE IF NOT EXISTS pocket_id_vercel_connection (
      name text PRIMARY KEY,
      client_id text NOT NULL,
      client_secret text NOT NULL,
      callback_url text NOT NULL,
      team_slug text,
      scim_provider_id text,
      scim_endpoint text,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  await workshopSql()`ALTER TABLE pocket_id_vercel_connection ADD COLUMN IF NOT EXISTS team_slug text`;
  await workshopSql()`ALTER TABLE pocket_id_vercel_connection ADD COLUMN IF NOT EXISTS last_auto_sync_at timestamptz`;
  await workshopSql()`ALTER TABLE pocket_id_vercel_connection ADD COLUMN IF NOT EXISTS last_sync_error text`;
  await workshopSql()`ALTER TABLE pocket_id_vercel_connection ADD COLUMN IF NOT EXISTS last_sync_attempt_at timestamptz`;
}

export async function recordSyncAttempt(name: string, error: string | null): Promise<void> {
  await initializeVercelConnection();
  await workshopSql()`
    UPDATE pocket_id_vercel_connection
    SET last_sync_error = ${error}, last_sync_attempt_at = now(), updated_at = now()
    WHERE name = ${name}
  `;
}

// One automatic SCIM push per window; concurrent signups share it.
export async function acquireAutoSyncSlot(name: string, windowSeconds: number): Promise<boolean> {
  await initializeVercelConnection();
  const rows = await workshopSql()`
    UPDATE pocket_id_vercel_connection
    SET last_auto_sync_at = now()
    WHERE name = ${name}
      AND scim_provider_id IS NOT NULL
      AND (last_auto_sync_at IS NULL OR last_auto_sync_at < now() - make_interval(secs => ${windowSeconds}))
    RETURNING name
  `;
  return rows.length > 0;
}

function mapConnection(row: Record<string, unknown>): VercelConnection {
  return {
    clientId: String(row.client_id),
    clientSecret: String(row.client_secret),
    callbackUrl: String(row.callback_url),
    teamSlug: row.team_slug ? String(row.team_slug) : null,
    scimProviderId: row.scim_provider_id ? String(row.scim_provider_id) : null,
    scimEndpoint: row.scim_endpoint ? String(row.scim_endpoint) : null,
    lastSyncError: row.last_sync_error ? String(row.last_sync_error) : null,
    lastSyncAttemptAt: row.last_sync_attempt_at ? new Date(String(row.last_sync_attempt_at)) : null,
    updatedAt: new Date(String(row.updated_at)),
  };
}

export async function getVercelConnection(name: string): Promise<VercelConnection | null> {
  await initializeVercelConnection();
  const rows = await workshopSql()`SELECT * FROM pocket_id_vercel_connection WHERE name = ${name}`;
  return rows.length ? mapConnection(rows[0] as Record<string, unknown>) : null;
}

export async function saveVercelConnection(
  name: string,
  connection: Omit<VercelConnection, 'updatedAt' | 'lastSyncError' | 'lastSyncAttemptAt'>,
): Promise<void> {
  await initializeVercelConnection();
  await workshopSql()`
    INSERT INTO pocket_id_vercel_connection (name, client_id, client_secret, callback_url, team_slug, scim_provider_id, scim_endpoint)
    VALUES (
      ${name}, ${connection.clientId}, ${connection.clientSecret}, ${connection.callbackUrl}, ${connection.teamSlug},
      ${connection.scimProviderId}, ${connection.scimEndpoint}
    )
    ON CONFLICT (name) DO UPDATE SET
      client_id = EXCLUDED.client_id,
      client_secret = EXCLUDED.client_secret,
      callback_url = EXCLUDED.callback_url,
      team_slug = EXCLUDED.team_slug,
      scim_provider_id = EXCLUDED.scim_provider_id,
      scim_endpoint = EXCLUDED.scim_endpoint,
      updated_at = now()
  `;
}
