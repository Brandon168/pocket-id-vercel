import { neon, type NeonQueryFunction } from '@neondatabase/serverless';

export type LifecycleState = {
  name: string;
  status: 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';
  origin: string | null;
  lastRequestAt: Date;
  leaseOwner: string | null;
  leaseUntil: Date | null;
  sessionExpiresAt: Date | null;
  lastError: string | null;
};
let sqlClient: NeonQueryFunction<false, false> | null = null;

function lifecycleSql() {
  if (sqlClient) return sqlClient;
  const connectionString = process.env.CONTROLLER_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('CONTROLLER_DATABASE_URL or DATABASE_URL is required');
  }
  sqlClient = neon(connectionString);
  return sqlClient;
}

export async function initializeLifecycleState(name: string): Promise<void> {
  const sql = lifecycleSql();
  await sql`
    CREATE TABLE IF NOT EXISTS pocket_id_sandbox_lifecycle (
      name text PRIMARY KEY,
      status text NOT NULL CHECK (status IN ('stopped', 'starting', 'running', 'stopping', 'failed')),
      origin text,
      last_request_at timestamptz NOT NULL DEFAULT now(),
      lease_owner text,
      lease_until timestamptz,
      session_expires_at timestamptz,
      last_error text,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  await sql`
    INSERT INTO pocket_id_sandbox_lifecycle (name, status)
    VALUES (${name}, 'stopped')
    ON CONFLICT (name) DO NOTHING
  `;
}

export async function markStarting(name: string, owner: string, origin: string): Promise<void> {
  const sql = lifecycleSql();
  await sql`
    UPDATE pocket_id_sandbox_lifecycle
    SET origin = ${origin}, updated_at = now()
    WHERE name = ${name} AND lease_owner = ${owner}
  `;
}

function mapState(row: Record<string, unknown>): LifecycleState {
  return {
    name: String(row.name),
    status: row.status as LifecycleState['status'],
    origin: row.origin ? String(row.origin) : null,
    lastRequestAt: new Date(String(row.last_request_at)),
    leaseOwner: row.lease_owner ? String(row.lease_owner) : null,
    leaseUntil: row.lease_until ? new Date(String(row.lease_until)) : null,
    sessionExpiresAt: row.session_expires_at ? new Date(String(row.session_expires_at)) : null,
    lastError: row.last_error ? String(row.last_error) : null,
  };
}

export async function getLifecycleState(name: string): Promise<LifecycleState> {
  const sql = lifecycleSql();
  await initializeLifecycleState(name);
  const rows = await sql`SELECT * FROM pocket_id_sandbox_lifecycle WHERE name = ${name}`;
  return mapState(rows[0] as Record<string, unknown>);
}

export async function touchActivity(name: string): Promise<void> {
  const sql = lifecycleSql();
  await sql`
    UPDATE pocket_id_sandbox_lifecycle
    SET last_request_at = now(), updated_at = now()
    WHERE name = ${name}
      AND last_request_at < now() - interval '60 seconds'
  `;
}

export async function acquireLifecycleLease(
  name: string,
  owner: string,
  nextStatus: LifecycleState['status'],
  durationSeconds = 45,
): Promise<boolean> {
  const sql = lifecycleSql();
  await initializeLifecycleState(name);
  const rows = await sql`
    UPDATE pocket_id_sandbox_lifecycle
    SET status = ${nextStatus},
        lease_owner = ${owner},
        lease_until = now() + (${durationSeconds} * interval '1 second'),
        last_error = NULL,
        updated_at = now()
    WHERE name = ${name}
      AND (lease_until IS NULL OR lease_until < now() OR lease_owner = ${owner})
    RETURNING name
  `;
  return rows.length === 1;
}

// Records a new Sandbox session deadline without touching idle tracking.
export async function updateSessionExpiry(name: string, expiresAt: Date): Promise<void> {
  const sql = lifecycleSql();
  await sql`
    UPDATE pocket_id_sandbox_lifecycle
    SET session_expires_at = ${expiresAt.toISOString()}, updated_at = now()
    WHERE name = ${name}
  `;
}

export async function markRunning(
  name: string,
  owner: string,
  origin: string,
  expiresAt: Date | undefined,
): Promise<void> {
  const sql = lifecycleSql();
  await sql`
    UPDATE pocket_id_sandbox_lifecycle
    SET status = 'running', origin = ${origin},
        session_expires_at = ${expiresAt?.toISOString() ?? null},
        lease_owner = NULL, lease_until = NULL, last_error = NULL,
        last_request_at = now(), updated_at = now()
    WHERE name = ${name} AND lease_owner = ${owner}
  `;
}

export async function markStopped(name: string, owner: string): Promise<void> {
  const sql = lifecycleSql();
  await sql`
    UPDATE pocket_id_sandbox_lifecycle
    SET status = 'stopped', session_expires_at = NULL,
        lease_owner = NULL, lease_until = NULL, updated_at = now()
    WHERE name = ${name} AND lease_owner = ${owner}
  `;
}

export async function markFailed(name: string, owner: string, error: unknown): Promise<void> {
  const sql = lifecycleSql();
  const message = error instanceof Error ? error.message : String(error);
  await sql`
    UPDATE pocket_id_sandbox_lifecycle
    SET status = 'failed', last_error = ${message.slice(0, 2000)},
        lease_owner = NULL, lease_until = NULL, updated_at = now()
    WHERE name = ${name} AND lease_owner = ${owner}
  `;
}
