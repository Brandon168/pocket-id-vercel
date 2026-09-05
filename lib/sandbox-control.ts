import { randomUUID } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { Sandbox } from '@vercel/sandbox';
import { requireSecrets } from './secrets';
import {
  acquireLifecycleLease,
  getLifecycleState,
  markFailed,
  markRunning,
  markStarting,
  markStopped,
  touchActivity,
  updateSessionExpiry,
} from './lifecycle-store';

const sandboxName = process.env.SANDBOX_NAME ?? 'pocket-id';
const sandboxPort = 1411;
const sandboxImage = process.env.SANDBOX_IMAGE ?? 'vercel/sandbox/universal:latest';
const startupTimeoutMs = Number(process.env.SANDBOX_STARTUP_TIMEOUT_MS ?? 60_000);
let knownOrigin: string | null = null;
let knownOriginUntil = 0;
let lastActivityTouchAt = 0;

export async function getKnownSandboxOrigin(): Promise<string> {
  if (knownOrigin && Date.now() < knownOriginUntil) return knownOrigin;
  const origin = await ensureSandboxReady();
  knownOrigin = origin;
  knownOriginUntil = Date.now() + 5 * 60_000;
  return origin;
}

export function invalidateKnownSandboxOrigin(): void {
  knownOrigin = null;
  knownOriginUntil = 0;
}

export async function recordProxyActivity(): Promise<void> {
  const now = Date.now();
  if (now - lastActivityTouchAt < 60_000) return;
  lastActivityTouchAt = now;
  await touchActivity(sandboxName);
}
function sleep(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}

async function deleteStoppedActorHost(): Promise<void> {
  const connectionString = process.env.DATABASE_URL_UNPOOLED;
  if (!connectionString) throw new Error('DATABASE_URL_UNPOOLED is required');
  const sql = neon(connectionString);
  await sql`DELETE FROM francis_hosts WHERE host_address = '127.0.0.1:1414'`;
}


async function pocketEnvironment(origin: string): Promise<string> {
  const connectionString = process.env.DATABASE_URL_UNPOOLED;
  if (!connectionString) throw new Error('DATABASE_URL_UNPOOLED is required');
  const secrets = await requireSecrets();
  const values: Record<string, string> = {
    ENCRYPTION_KEY: secrets.encryptionKey,
    STATIC_API_KEY: secrets.staticApiKey,
  };
  const productionOrigin = process.env.APP_URL
    ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : origin);
  Object.assign(values, {
    DB_CONNECTION_STRING: connectionString,
    APP_URL: productionOrigin,
    APP_ENV: 'production',
    PORT: String(sandboxPort),
    ACTORS_HOST: '127.0.0.1',
    FILE_BACKEND: 'database',
    GEOLITE_DB_PATH: '/tmp/GeoLite2-City.mmdb',
    TRUSTED_PLATFORM: 'X-Real-IP',
    ALLOW_INSECURE_CALLBACK_URLS: 'false',
    ANALYTICS_DISABLED: 'true',
    VERSION_CHECK_DISABLED: 'true',

    LOG_JSON: 'true',
    // Hundreds of attendees share conference NAT addresses.
    DISABLE_RATE_LIMITING: 'true',
  });
  return Object.entries(values)
    .map(([key, value]) => `export ${key}='${value.replaceAll("'", "'\\''")}'`)
    .join('\n') + '\n';
}

async function startPocketId(sandbox: Sandbox, origin: string): Promise<void> {
  const encodedEnvironment = new TextEncoder().encode(await pocketEnvironment(origin));
  await sandbox.writeFiles([
    { path: '/tmp/pocket-env.sh', content: encodedEnvironment, mode: 0o600 },
  ]);
  const processCount = await sandbox.runCommand('sh', [
    '-lc',
    "pgrep -x pocket-id 2>/dev/null | wc -l",
  ]);
  if ((await processCount.stdout()).trim() === '0') {
    await sandbox.runCommand({
      cmd: 'sh',
      args: ['-lc', '. /tmp/pocket-env.sh && exec "$(command -v /app/pocket-id 2>/dev/null || echo /tmp/pocket-id)" >>/tmp/pocket-id.log 2>&1'],
      detached: true,
    });
  }
}

async function waitForHealth(origin: string): Promise<void> {
  const deadline = Date.now() + startupTimeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/healthz`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(2_000),
      });
      if (response.status === 204) return;
      lastError = new Error(`healthz returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(`Pocket ID did not become healthy: ${String(lastError)}`);
}

async function resumeAsLeaseOwner(owner: string): Promise<string> {
  // Fail before creating anything if first-run setup has not happened; a
  // Sandbox with no secrets to hand Pocket ID would only sit idle and bill.
  await requireSecrets();
  const idleMinutes = Number(process.env.SANDBOX_IDLE_MINUTES ?? 120);
  const requiredMs = (idleMinutes + 5) * 60_000;
  const sandbox = await Sandbox.getOrCreate({
    name: sandboxName,
    image: sandboxImage,
    ports: [sandboxPort],
    timeout: requiredMs,
    resources: { vcpus: 1 },
    persistent: true,
    keepLastSnapshots: { count: 1 },
    onCreate: async (created) => {
      if (sandboxImage !== 'vercel/sandbox/universal:latest') return;
      const download = await created.runCommand('sh', [
        '-lc',
        'curl -fsSL https://github.com/pocket-id/pocket-id/releases/download/v2.14.0/pocket-id_linux_amd64 -o /tmp/pocket-id && echo "da32b4e7bc8ba817ae2cee6e62634834bf234965fa237d25ab38fc3bec58ef48  /tmp/pocket-id" | sha256sum -c - && chmod 700 /tmp/pocket-id',
      ]);
      if (download.exitCode !== 0) throw new Error(`Pocket ID download failed: ${await download.stderr()}`);
    },
    resume: true,
  });
  const origin = `https://${new URL(sandbox.domain(sandboxPort)).host}`;
  await markStarting(sandboxName, owner, origin);
  await startPocketId(sandbox, origin);
  const sessionRemaining = sandbox.expiresAt ? sandbox.expiresAt.getTime() - Date.now() : 0;
  if (sessionRemaining < requiredMs) {
    await sandbox.extendTimeout(requiredMs - Math.max(sessionRemaining, 0));
  }
  await waitForHealth(origin);
  await markRunning(sandboxName, owner, origin, sandbox.expiresAt);
  return origin;
}

export async function ensureSandboxReady(): Promise<string> {
  const state = await getLifecycleState(sandboxName);
  if (state.status === 'running' && state.origin) {
    try {
      const sandbox = await Sandbox.get({ name: sandboxName, resume: false });
      if (sandbox.status === 'running') {
        const response = await fetch(`${state.origin}/healthz`, {
          cache: 'no-store',
          signal: AbortSignal.timeout(1_000),
        });
        if (response.status === 204) {
          knownOrigin = state.origin;
          knownOriginUntil = Date.now() + 5 * 60_000;
          return state.origin;
        }
      }
    } catch {
      // Acquire the lease below; another function may already be recovering it.
    }
  }

  const owner = randomUUID();
  if (await acquireLifecycleLease(sandboxName, owner, 'starting')) {
    try {
      const origin = await resumeAsLeaseOwner(owner);
      knownOrigin = origin;
      knownOriginUntil = Date.now() + 5 * 60_000;
      return origin;
    } catch (error) {
      await markFailed(sandboxName, owner, error);
      throw error;
    }
  }

  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    await sleep(200);
    const current = await getLifecycleState(sandboxName);
    if (current.status === 'running' && current.origin) {
      knownOrigin = current.origin;
      knownOriginUntil = Date.now() + 5 * 60_000;
      return current.origin;
    }
    if (current.status === 'failed') throw new Error(current.lastError ?? 'Sandbox startup failed');
    if (current.leaseUntil && current.leaseUntil.getTime() < Date.now()) return ensureSandboxReady();
  }
  throw new Error('Timed out waiting for another request to start Pocket ID');
}

export async function stopIfIdle(): Promise<'kept' | 'stopped'> {
  const idleMinutes = Number(process.env.SANDBOX_IDLE_MINUTES ?? 120);
  const state = await getLifecycleState(sandboxName);
  if (state.status !== 'running') return 'kept';

  try {
    const currentSandbox = await Sandbox.get({ name: sandboxName, resume: false });
    if (currentSandbox.status !== 'running') {
      const reconcileOwner = randomUUID();
      if (await acquireLifecycleLease(sandboxName, reconcileOwner, 'stopping', 30)) {
        await markStopped(sandboxName, reconcileOwner);
      }
      return 'stopped';
    }
  } catch {
    return 'kept';
  }

  if (Date.now() - state.lastRequestAt.getTime() < idleMinutes * 60_000) {
    // Still in use. The session deadline was set to idle + 5 minutes when
    // the Sandbox started; keep it at least that far ahead so a busy
    // workshop never dies mid-session. Runs every minute from the cron.
    await keepSessionAlive(idleMinutes);
    return 'kept';
  }
  const owner = randomUUID();
  if (!(await acquireLifecycleLease(sandboxName, owner, 'stopping', 90))) return 'kept';
  const afterLease = await getLifecycleState(sandboxName);
  if (Date.now() - afterLease.lastRequestAt.getTime() < idleMinutes * 60_000) {
    await markRunning(sandboxName, owner, afterLease.origin ?? '', afterLease.sessionExpiresAt ?? undefined);
    return 'kept';
  }

  try {
    const sandbox = await Sandbox.get({ name: sandboxName, resume: false });
    if (sandbox.status === 'running') {
      await sandbox.runCommand('sh', [
        '-lc',
        'pkill -TERM -x pocket-id 2>/dev/null || true; sleep 12; pgrep -x pocket-id >/dev/null && exit 1 || exit 0',
      ]);
      await deleteStoppedActorHost();
      await sandbox.stop();
    }
    await markStopped(sandboxName, owner);
    invalidateKnownSandboxOrigin();
    return 'stopped';
  } catch (error) {
    await markFailed(sandboxName, owner, error);
    throw error;
  }
}

// Extends the Sandbox session so it always ends at least idle + 5 minutes
// from now while traffic continues. Vercel caps how far a session can be
// extended; when the cap is reached the next request after expiry resumes
// the Sandbox from its snapshot (about a minute of downtime).
async function keepSessionAlive(idleMinutes: number): Promise<void> {
  try {
    const sandbox = await Sandbox.get({ name: sandboxName, resume: false });
    if (sandbox.status !== 'running' || !sandbox.expiresAt) return;
    const requiredMs = (idleMinutes + 5) * 60_000;
    const remaining = sandbox.expiresAt.getTime() - Date.now();
    // Only extend when the deadline has drifted meaningfully (avoids an API
    // call every minute); keep at least an hour of headroom on top.
    if (remaining >= requiredMs - 60 * 60_000) return;
    await sandbox.extendTimeout(requiredMs - remaining);
    if (sandbox.expiresAt) await updateSessionExpiry(sandboxName, sandbox.expiresAt);
  } catch (error) {
    console.error('Sandbox session extension failed', error);
  }
}

export async function getControllerStatus() {
  const state = await getLifecycleState(sandboxName);
  let sandboxStatus: string = 'unavailable';
  try {
    const sandbox = await Sandbox.get({ name: sandboxName, resume: false });
    sandboxStatus = sandbox.status;
  } catch {
    // Named sandbox may not exist yet.
  }
  return { ...state, sandboxStatus };
}

export async function stopSandboxNow(): Promise<void> {
  const owner = randomUUID();
  if (!(await acquireLifecycleLease(sandboxName, owner, 'stopping', 90))) {
    throw new Error('Sandbox lifecycle is busy');
  }
  try {
    const sandbox = await Sandbox.get({ name: sandboxName, resume: false });
    if (sandbox.status === 'running') {
      await sandbox.runCommand('sh', [
        '-lc',
        'pkill -TERM -x pocket-id 2>/dev/null || true; sleep 12; pgrep -x pocket-id >/dev/null && exit 1 || exit 0',
      ]);
      await deleteStoppedActorHost();
      await sandbox.stop();
    }
    await markStopped(sandboxName, owner);
    invalidateKnownSandboxOrigin();
  } catch (error) {
    await markFailed(sandboxName, owner, error);
    throw error;
  }
}
