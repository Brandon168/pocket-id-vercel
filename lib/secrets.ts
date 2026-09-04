import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { neon, type NeonQueryFunction } from '@neondatabase/serverless';

export type WorkshopSecrets = {
  encryptionKey: string;
  staticApiKey: string;
  adminSecretHash: string;
  createdAt: Date;
};

export type ClaimedSecrets = {
  adminSecret: string;
  staticApiKey: string;
  createdAt: Date;
};

const secretsName = process.env.SANDBOX_NAME ?? 'pocket-id';
let sqlClient: NeonQueryFunction<false, false> | null = null;
let cached: WorkshopSecrets | null = null;

function secretsSql() {
  if (sqlClient) return sqlClient;
  const connectionString = process.env.CONTROLLER_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error('CONTROLLER_DATABASE_URL or DATABASE_URL is required');
  sqlClient = neon(connectionString);
  return sqlClient;
}

async function initializeSecrets(): Promise<void> {
  await secretsSql()`
    CREATE TABLE IF NOT EXISTS pocket_id_secrets (
      name text PRIMARY KEY,
      encryption_key text NOT NULL,
      static_api_key text NOT NULL,
      admin_secret_hash text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `;
}

function hashSecret(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function mapSecrets(row: Record<string, unknown>): WorkshopSecrets {
  return {
    encryptionKey: String(row.encryption_key),
    staticApiKey: String(row.static_api_key),
    adminSecretHash: String(row.admin_secret_hash),
    createdAt: new Date(String(row.created_at)),
  };
}

// Environment variables override the database so existing deployments and
// local development keep working without a first-run claim.
function fromEnvironment(): WorkshopSecrets | null {
  const { ENCRYPTION_KEY, STATIC_API_KEY, WORKSHOP_ADMIN_SECRET } = process.env;
  if (!ENCRYPTION_KEY || !STATIC_API_KEY || !WORKSHOP_ADMIN_SECRET) return null;
  return {
    encryptionKey: ENCRYPTION_KEY,
    staticApiKey: STATIC_API_KEY,
    adminSecretHash: hashSecret(WORKSHOP_ADMIN_SECRET),
    createdAt: new Date(0),
  };
}

function withEnvironmentOverrides(stored: WorkshopSecrets): WorkshopSecrets {
  return {
    encryptionKey: process.env.ENCRYPTION_KEY ?? stored.encryptionKey,
    staticApiKey: process.env.STATIC_API_KEY ?? stored.staticApiKey,
    adminSecretHash: process.env.WORKSHOP_ADMIN_SECRET
      ? hashSecret(process.env.WORKSHOP_ADMIN_SECRET)
      : stored.adminSecretHash,
    createdAt: stored.createdAt,
  };
}

// Secrets are written exactly once per workshop, so a positive result is safe
// to cache for the life of the function instance.
export async function getSecrets(): Promise<WorkshopSecrets | null> {
  if (cached) return cached;
  const environment = fromEnvironment();
  if (environment) {
    cached = environment;
    return cached;
  }
  await initializeSecrets();
  const rows = await secretsSql()`SELECT * FROM pocket_id_secrets WHERE name = ${secretsName}`;
  if (!rows.length) return null;
  cached = withEnvironmentOverrides(mapSecrets(rows[0] as Record<string, unknown>));
  return cached;
}

export async function requireSecrets(): Promise<WorkshopSecrets> {
  const secrets = await getSecrets();
  if (!secrets) throw new Error('Workshop has not completed first-run setup. Open /setup.');
  return secrets;
}

export async function isSetupComplete(): Promise<boolean> {
  return (await getSecrets()) !== null;
}

// Generates all secrets and stores them atomically. Exactly one caller wins;
// every other caller, including a double-click, receives null.
export async function claimSecrets(): Promise<ClaimedSecrets | null> {
  if (fromEnvironment()) return null;
  await initializeSecrets();
  const encryptionKey = randomBytes(32).toString('hex');
  const staticApiKey = randomBytes(32).toString('base64url');
  const adminSecret = randomBytes(24).toString('base64url');
  const rows = await secretsSql()`
    INSERT INTO pocket_id_secrets (name, encryption_key, static_api_key, admin_secret_hash)
    VALUES (${secretsName}, ${encryptionKey}, ${staticApiKey}, ${hashSecret(adminSecret)})
    ON CONFLICT (name) DO NOTHING
    RETURNING created_at
  `;
  if (!rows.length) return null;
  cached = null;
  return {
    adminSecret,
    staticApiKey,
    createdAt: new Date(String((rows[0] as Record<string, unknown>).created_at)),
  };
}

export async function verifyAdminSecret(supplied: string): Promise<boolean> {
  const secrets = await getSecrets();
  if (!secrets) return false;
  const suppliedHash = Buffer.from(hashSecret(supplied), 'hex');
  const expectedHash = Buffer.from(secrets.adminSecretHash, 'hex');
  return suppliedHash.length === expectedHash.length && timingSafeEqual(suppliedHash, expectedHash);
}
