import { getLifecycleState } from './lifecycle-store';
import { getKnownSandboxOrigin } from './sandbox-control';
import { requireSecrets } from './secrets';
import {
  getWorkshopOptions,
  getWorkshopSetup,
  saveWorkshopSetup,
  updateAdminLoginUrl,
  type WorkshopOptions,
  type WorkshopSetup,
} from './workshop-store';

const workshopName = process.env.SANDBOX_NAME ?? 'pocket-id';
// Pocket ID caps one signup token at 100 uses (signupTokenCreateDto: max=100).
const tokenUsageLimit = 100;
const headroom = 1.2;
const tokenTtl = '72h';
// Calls are strictly serial against one Pocket ID process; the gap only exists
// as a safety margin. Admin API rate limiting is 100 req/s and disabled anyway.
const mutationDelayMs = Number(process.env.WORKSHOP_SETUP_DELAY_MS ?? 1_000);

export function signupTokenCount(expectedAttendees: number): number {
  return Math.max(1, Math.ceil((expectedAttendees * headroom) / tokenUsageLimit));
}

export function estimateSetupSeconds(expectedAttendees: number): number {
  // Eight fixed mutations plus one per token, each followed by a pause,
  // plus the API round trips themselves.
  const mutations = 8 + signupTokenCount(expectedAttendees);
  return Math.ceil((mutations * (mutationDelayMs + 400)) / 1000);
}

function sleep(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}

function appUrl(requestOrigin: string): string {
  return (process.env.APP_URL ?? requestOrigin).replace(/\/$/, '');
}

async function pocketApi<T>(origin: string, path: string, init?: RequestInit): Promise<T> {
  const { staticApiKey: key } = await requireSecrets();
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

async function configureSignups(origin: string, options: WorkshopOptions): Promise<void> {
  const all = await pocketApi<Array<{ key: string; value: string }>>(origin, '/application-configuration/all');
  const configuration = Object.fromEntries(all.map(({ key, value }) => [key, value]));
  Object.assign(configuration, {
    allowUserSignups: 'withToken',
    // Pocket ID only exposes a requirement toggle for email. First and last
    // name are always optional in its signup DTO.
    requireUserEmail: options.requireEmail ? 'true' : 'false',
    emailsVerified: 'false',
    emailVerificationEnabled: 'false',
    // Attendees who skip passkey creation stay signed in for the whole event.
    sessionDuration: String(30 * 24 * 60),
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

// One-time login links. Pocket ID issues a 6-character code for TTLs up to
// 15 minutes and a 12-character code beyond that; the code page auto-submits
// either. Links are minted on demand rather than stored, because a stale
// code fails silently and drops the user on a manual code-entry form.
//
// The canonical /login/alternative/code URL is used instead of the /lc/<code>
// alias: the alias performs a client-side 307 that races the page's own
// post-login navigation, leaving the user signed in but stuck on the form.
export const loginLinkTtl = '1h';

export type LoginLink = { code: string; loginUrl: string; codeEntryUrl: string };

async function mintLoginLink(origin: string, publicOrigin: string, userId: string, redirectPath: string): Promise<LoginLink> {
  const { token } = await pocketApi<{ token: string }>(origin, `/users/${userId}/one-time-access-token`, {
    method: 'POST',
    body: JSON.stringify({ ttl: loginLinkTtl }),
  });
  const url = new URL('/login/alternative/code', publicOrigin);
  url.searchParams.set('code', token);
  url.searchParams.set('redirect', redirectPath);
  // /lc is Pocket ID's short alias for the manual code-entry page.
  return { code: token, loginUrl: url.toString(), codeEntryUrl: `${publicOrigin}/lc` };
}

async function mintSignupTokens(origin: string, groupId: string, tokenCount: number): Promise<string[]> {
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

  const options = await getWorkshopOptions(workshopName);
  const tokenCount = signupTokenCount(options.expectedAttendees);
  const origin = await getKnownSandboxOrigin();
  const publicOrigin = appUrl(requestOrigin);
  await configureSignups(origin, options);
  const admin = await ensureAdmin(origin);
  const group = await ensureGroup(origin);
  await ensureClient(origin, group.id);
  await addAdminToGroup(origin, group.id, admin.id);
  // Stored for schema compatibility only; the console mints a fresh link on demand.
  const { loginUrl: adminLoginUrl } = await mintLoginLink(origin, publicOrigin, admin.id, '/settings/admin/users');
  await pause();
  const signupTokens = await mintSignupTokens(origin, group.id, tokenCount);
  const setup: WorkshopSetup = {
    adminId: admin.id,
    adminUsername: admin.username,
    adminLoginUrl,
    joinUrl: `${publicOrigin}/join`,
    signupTokens,
    capacity: tokenCount * tokenUsageLimit,
    expiresAt: new Date(Date.now() + 72 * 60 * 60_000),
  };
  await saveWorkshopSetup(workshopName, setup);
  return setup;
}

export type AdminLogin = { loginUrl: string; ttl: string };

// Mints a fresh admin login and lands the instructor on the admin users page.
export async function refreshAdminLogin(requestOrigin: string): Promise<AdminLogin> {
  const setup = await getWorkshopSetup(workshopName);
  if (!setup) throw new Error('Workshop has not been set up');
  const origin = await getKnownSandboxOrigin();
  const { loginUrl } = await mintLoginLink(origin, appUrl(requestOrigin), setup.adminId, '/settings/admin/users');
  await updateAdminLoginUrl(workshopName, loginUrl);
  return { loginUrl, ttl: loginLinkTtl };
}

export type AttendeeLogin = LoginLink & {
  username: string;
  displayName: string;
};

export class AttendeeNotFoundError extends Error {
  constructor(identifier: string) {
    super(`No attendee matching '${identifier}'`);
  }
}

type PocketUser = {
  id: string;
  username: string;
  displayName?: string;
  email?: string | null;
  isAdmin: boolean;
  disabled: boolean;
};

async function findAttendee(origin: string, selector: { userId?: string; username?: string }): Promise<PocketUser> {
  if (selector.userId) {
    try {
      return await pocketApi<PocketUser>(origin, `/users/${encodeURIComponent(selector.userId)}`);
    } catch {
      throw new AttendeeNotFoundError(selector.userId);
    }
  }
  const username = selector.username?.trim().toLowerCase() ?? '';
  if (!username) throw new AttendeeNotFoundError(selector.username ?? '');
  const found = await pocketApi<Paginated<PocketUser>>(
    origin,
    `/users?search=${encodeURIComponent(username)}&pagination[limit]=20`,
  );
  const user = found.data?.find((candidate) => candidate.username.toLowerCase() === username);
  if (!user) throw new AttendeeNotFoundError(username);
  return user;
}

// Mints a one-time login for an attendee who cannot use a passkey.
export async function issueAttendeeLogin(
  requestOrigin: string,
  selector: { userId?: string; username?: string },
): Promise<AttendeeLogin> {
  const origin = await getKnownSandboxOrigin();
  const user = await findAttendee(origin, selector);
  const link = await mintLoginLink(origin, appUrl(requestOrigin), user.id, '/settings/account');
  return { ...link, username: user.username, displayName: user.displayName?.trim() || user.username };
}

export type Attendee = {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  disabled: boolean;
  // null when the passkey lookup failed; the UI shows "unknown".
  hasPasskey: boolean | null;
};

export type AttendeePage = {
  attendees: Attendee[];
  page: number;
  totalPages: number;
  totalItems: number;
};

type PaginationInfo = { totalPages?: number; totalItems?: number; currentPage?: number };
const attendeePageSize = 25;
const passkeyLookupConcurrency = 4;

async function hasPasskey(origin: string, userId: string): Promise<boolean | null> {
  try {
    const result = await pocketApi<unknown>(origin, `/users/${encodeURIComponent(userId)}/webauthn-credentials`);
    const credentials = Array.isArray(result) ? result : (result as Paginated<unknown>)?.data ?? [];
    return credentials.length > 0;
  } catch {
    return null;
  }
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

// Lists non-admin users (attendees), newest first, with passkey status.
export async function listAttendees(search: string, page: number): Promise<AttendeePage> {
  const origin = await getKnownSandboxOrigin();
  const params = new URLSearchParams({
    'pagination[page]': String(Math.max(1, page)),
    'pagination[limit]': String(attendeePageSize),
    'sort[column]': 'createdAt',
    'sort[direction]': 'desc',
    'filters[isAdmin]': 'false',
  });
  if (search.trim()) params.set('search', search.trim());
  const listed = await pocketApi<Paginated<PocketUser> & { pagination?: PaginationInfo }>(origin, `/users?${params}`);
  const users = listed.data ?? [];
  const passkeys = await mapWithConcurrency(users, passkeyLookupConcurrency, (user) => hasPasskey(origin, user.id));
  return {
    attendees: users.map((user, index) => ({
      id: user.id,
      username: user.username,
      displayName: user.displayName?.trim() || user.username,
      email: user.email ?? null,
      disabled: user.disabled,
      hasPasskey: passkeys[index],
    })),
    page: listed.pagination?.currentPage ?? page,
    totalPages: listed.pagination?.totalPages ?? 1,
    totalItems: listed.pagination?.totalItems ?? users.length,
  };
}

export type SignupProgress = {
  used: number;
  capacity: number;
  sandboxRunning: boolean;
};

type SignupToken = { token: string; usageLimit: number; usageCount: number };

// Reads signup token usage without waking a stopped Sandbox.
export async function getSignupProgress(): Promise<SignupProgress> {
  const setup = await getWorkshopSetup(workshopName);
  if (!setup) return { used: 0, capacity: 0, sandboxRunning: false };
  const state = await getLifecycleState(workshopName);
  if (state.status !== 'running') return { used: 0, capacity: setup.capacity, sandboxRunning: false };
  const origin = await getKnownSandboxOrigin();
  const listed = await pocketApi<Paginated<SignupToken>>(origin, '/signup-tokens?pagination[limit]=100');
  const ours = new Set(setup.signupTokens);
  const used = (listed.data ?? [])
    .filter((token) => ours.has(token.token))
    .reduce((total, token) => total + token.usageCount, 0);
  return { used, capacity: setup.capacity, sandboxRunning: true };
}

export function getWorkshopName(): string {
  return workshopName;
}
