import { getKnownSandboxOrigin } from './sandbox-control';
import {
  getWorkshopSetup,
  saveWorkshopSetup,
  updateAdminLoginUrl,
  type WorkshopSetup,
} from './workshop-store';

const workshopName = process.env.SANDBOX_NAME ?? 'pocket-id';
const capacity = 1_000;
const tokenCount = 10;
const tokenUsageLimit = 100;
const tokenTtl = '72h';
const mutationDelayMs = Number(process.env.WORKSHOP_SETUP_DELAY_MS ?? 6_000);

function sleep(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}

function appUrl(requestOrigin: string): string {
  return (process.env.APP_URL ?? requestOrigin).replace(/\/$/, '');
}

async function pocketApi<T>(origin: string, path: string, init?: RequestInit): Promise<T> {
  const key = process.env.STATIC_API_KEY;
  if (!key) throw new Error('STATIC_API_KEY is required');
  const response = await fetch(`${origin}/api${path}`, {
    ...init,
    cache: 'no-store',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      ...init?.headers,
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Pocket ID ${path} returned ${response.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) as T : undefined as T;
}

async function pause(): Promise<void> {
  if (mutationDelayMs > 0) await sleep(mutationDelayMs);
}

type Paginated<T> = { data?: T[] };
type User = { id: string; username: string; isAdmin: boolean };
type Group = { id: string; name: string; users?: Array<{ id: string }> };

async function configureSignups(origin: string): Promise<void> {
  const all = await pocketApi<Array<{ key: string; value: string }>>(origin, '/application-configuration/all');
  const configuration = Object.fromEntries(all.map(({ key, value }) => [key, value]));
  Object.assign(configuration, {
    allowUserSignups: 'withToken',
    requireUserEmail: 'false',
    emailsVerified: 'false',
    emailVerificationEnabled: 'false',
  });
  await pocketApi(origin, '/application-configuration', {
    method: 'PUT',
    body: JSON.stringify(configuration),
  });
  await pause();
}

async function ensureAdmin(origin: string): Promise<User> {
  const username = 'instructor';
  const found = await pocketApi<Paginated<User>>(origin, `/users?search=${username}&pagination[limit]=5`);
  const existing = found.data?.find((user) => user.username === username);
  if (existing) {
    if (!existing.isAdmin) throw new Error("The existing 'instructor' user is not an administrator");
    return existing;
  }
  const created = await pocketApi<User>(origin, '/users', {
    method: 'POST',
    body: JSON.stringify({ username, firstName: 'Instructor', isAdmin: true }),
  });
  await pause();
  return created;
}

async function ensureGroup(origin: string): Promise<Group> {
  const found = await pocketApi<Paginated<Group>>(origin, '/user-groups?search=workshop&pagination[limit]=5');
  const existing = found.data?.find((group) => group.name === 'workshop');
  if (existing) return existing;
  const created = await pocketApi<Group>(origin, '/user-groups', {
    method: 'POST',
    body: JSON.stringify({ friendlyName: 'workshop', name: 'workshop' }),
  });
  await pause();
  return created;
}

async function ensureClient(origin: string, groupId: string): Promise<void> {
  let exists = false;
  try {
    const client = await pocketApi<{ id: string }>(origin, '/oidc/clients/workshop-app');
    exists = client.id === 'workshop-app';
  } catch {
    // Create the fixed workshop client below.
  }
  if (!exists) {
    await pocketApi(origin, '/oidc/clients', {
      method: 'POST',
      body: JSON.stringify({
        id: 'workshop-app',
        name: 'Workshop App',
        description: 'Workshop RP (public, PKCE)',
        callbackURLs: ['https://*.vercel.app/api/auth/callback/pocket-id'],
        logoutCallbackURLs: [],
        isPublic: true,
        pkceEnabled: true,
        skipConsent: true,
      }),
    });
    await pause();
  }
  await pocketApi(origin, '/oidc/clients/workshop-app/allowed-user-groups', {
    method: 'PUT',
    body: JSON.stringify({ userGroupIds: [groupId] }),
  });
  await pause();
}

async function addAdminToGroup(origin: string, groupId: string, adminId: string): Promise<void> {
  const group = await pocketApi<Group>(origin, `/user-groups/${groupId}`);
  const userIds = group.users?.map((user) => user.id) ?? [];
  if (!userIds.includes(adminId)) userIds.push(adminId);
  await pocketApi(origin, `/user-groups/${groupId}/users`, {
    method: 'PUT',
    body: JSON.stringify({ userIds }),
  });
  await pause();
}

async function mintAdminLogin(origin: string, publicOrigin: string, adminId: string): Promise<string> {
  const { token } = await pocketApi<{ token: string }>(origin, `/users/${adminId}/one-time-access-token`, {
    method: 'POST',
    body: '{}',
  });
  return `${publicOrigin}/lc/${token}`;
}

async function mintSignupTokens(origin: string, groupId: string): Promise<string[]> {
  const tokens: string[] = [];
  for (let index = 0; index < tokenCount; index += 1) {
    const result = await pocketApi<{ token: string }>(origin, '/signup-tokens', {
      method: 'POST',
      body: JSON.stringify({ ttl: tokenTtl, usageLimit: tokenUsageLimit, userGroupIds: [groupId] }),
    });
    tokens.push(result.token);
    await pause();
  }
  return tokens;
}

export async function setupWorkshop(requestOrigin: string): Promise<WorkshopSetup> {
  const existing = await getWorkshopSetup(workshopName);
  if (existing) return existing;

  const origin = await getKnownSandboxOrigin();
  const publicOrigin = appUrl(requestOrigin);
  await configureSignups(origin);
  const admin = await ensureAdmin(origin);
  const group = await ensureGroup(origin);
  await ensureClient(origin, group.id);
  await addAdminToGroup(origin, group.id, admin.id);
  const adminLoginUrl = await mintAdminLogin(origin, publicOrigin, admin.id);
  await pause();
  const signupTokens = await mintSignupTokens(origin, group.id);
  const setup: WorkshopSetup = {
    adminId: admin.id,
    adminUsername: admin.username,
    adminLoginUrl,
    joinUrl: `${publicOrigin}/join`,
    signupTokens,
    capacity,
    expiresAt: new Date(Date.now() + 72 * 60 * 60_000),
  };
  await saveWorkshopSetup(workshopName, setup);
  return setup;
}

export async function refreshAdminLogin(requestOrigin: string): Promise<WorkshopSetup> {
  const setup = await getWorkshopSetup(workshopName);
  if (!setup) throw new Error('Workshop has not been set up');
  const origin = await getKnownSandboxOrigin();
  const adminLoginUrl = await mintAdminLogin(origin, appUrl(requestOrigin), setup.adminId);
  await updateAdminLoginUrl(workshopName, adminLoginUrl);
  return { ...setup, adminLoginUrl };
}

export function getWorkshopName(): string {
  return workshopName;
}
