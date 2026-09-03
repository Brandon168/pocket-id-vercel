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
