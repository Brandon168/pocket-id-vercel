import { getLifecycleState } from './lifecycle-store';
import { getKnownSandboxOrigin } from './sandbox-control';
import { requireSecrets } from './secrets';
import {
  acquireAutoSyncSlot,
  acquirePrepareLease,
  defaultWorkshopOptions,
  getVercelConnection,
  getWorkshopOptions,
  getWorkshopSetup,
  recordSyncAttempt,
  releasePrepareLease,
  saveVercelConnection,
  saveWorkshopSetup,
  updateAdminLoginUrl,
  type VercelConnection,
  type WorkshopMode,
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

// Vercel team mode. Vercel's "Custom OIDC" SSO dialog shows a per-team
// login redirect URL of the form https://auth.vercel.com/sso/oidc/<id>/callback.
// Pocket ID's single-segment wildcard covers every team, so nothing needs to
// be pasted back; the console still lets the instructor pin an exact URL.
export const vercelSsoClientId = 'vercel-sso';
export const defaultVercelCallbackUrl = 'https://auth.vercel.com/sso/oidc/*/callback';
// Directory Sync falls back to this group name to assign the Member role when
// no explicit mapping is configured, so attendees never land as viewers.
export const vercelMemberGroupName = 'vercel-role-member';
// The instructor always sits in this group so the first Directory Sync run
// cannot demote or remove the person who confirmed it.
export const vercelOwnerGroupName = 'vercel-role-owner';
export const workshopGroupName = 'workshop';

export function signupTokenCount(expectedAttendees: number): number {
  return Math.max(1, Math.ceil((expectedAttendees * headroom) / tokenUsageLimit));
}

export function estimateSetupSeconds(expectedAttendees: number, mode: WorkshopMode = 'app'): number {
  // Fixed mutations plus one per token, each followed by a pause, plus the
  // API round trips themselves. Vercel team mode adds the role group, the
  // confidential client, and its secret.
  const fixed = mode === 'vercel-team' ? 11 : 8;
  const mutations = fixed + signupTokenCount(expectedAttendees);
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
type User = { id: string; username: string; isAdmin: boolean; email?: string | null; firstName?: string; lastName?: string; displayName?: string };
type Group = { id: string; name: string; friendlyName?: string; users?: Array<{ id: string }> };

async function configureSignups(origin: string, options: WorkshopOptions): Promise<void> {
  const all = await pocketApi<Array<{ key: string; value: string }>>(origin, '/application-configuration/all');
  const configuration = Object.fromEntries(all.map(({ key, value }) => [key, value]));
  const vercelTeam = options.mode === 'vercel-team';
  Object.assign(configuration, {
    allowUserSignups: 'withToken',
    // Pocket ID only exposes a requirement toggle for email. First and last
    // name are always optional in its signup DTO. In Vercel team mode the
    // proxy assigns <username>@<domain> itself, so the field stays optional
    // and attendees cannot type a wrong domain.
    requireUserEmail: !vercelTeam && options.requireEmail ? 'true' : 'false',
    // The team verified the domain, so addresses the proxy assigns can be
    // presented to Vercel as verified. Nothing is ever emailed.
    emailsVerified: vercelTeam ? 'true' : 'false',
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
    body: JSON.stringify({ username, firstName: 'Workshop', lastName: 'Instructor', isAdmin: true }),
  });
  await pause();
  return created;
}

// Pocket ID's SCIM push sends friendlyName as the group's displayName, which
// is what Vercel matches its reserved vercel-role-* names against. So the
// friendly name must equal the technical name; an existing group with a
// different friendly name is corrected here.
async function ensureGroup(origin: string, name: string, friendlyName: string = name): Promise<Group> {
  const found = await pocketApi<Paginated<Group>>(
    origin,
    `/user-groups?search=${encodeURIComponent(name)}&pagination[limit]=5`,
  );
  const existing = found.data?.find((group) => group.name === name);
  if (existing) {
    if (existing.friendlyName !== friendlyName) {
      await pocketApi(origin, `/user-groups/${existing.id}`, {
        method: 'PUT',
        body: JSON.stringify({ friendlyName, name }),
      });
      await pause();
    }
    return existing;
  }
  const created = await pocketApi<Group>(origin, '/user-groups', {
    method: 'POST',
    body: JSON.stringify({ friendlyName, name }),
  });
  await pause();
  return created;
}

async function clientExists(origin: string, clientId: string): Promise<boolean> {
  try {
    const client = await pocketApi<{ id: string }>(origin, `/oidc/clients/${clientId}`);
    return client.id === clientId;
  } catch {
    return false;
  }
}

// Pocket ID's client record as returned by GET /oidc/clients/{id}. Only the
// fields the update DTO accepts are carried over on PUT.
type PocketClient = {
  id: string;
  name: string;
  description?: string;
  callbackURLs?: string[];
  logoutCallbackURLs?: string[];
  isPublic: boolean;
  pkceEnabled: boolean;
  requiresReauthentication?: boolean;
  requiresPushedAuthorizationRequests?: boolean;
  skipConsent?: boolean;
  launchURL?: string | null;
  isGroupRestricted?: boolean;
  accessTokenDurationMinutes?: number;
  refreshTokenDurationMinutes?: number;
  credentials?: { federatedIdentities?: unknown[] };
};

function clientUpdateBody(client: PocketClient, overrides: Partial<PocketClient>): Record<string, unknown> {
  const merged = { ...client, ...overrides };
  return {
    name: merged.name,
    description: merged.description ?? '',
    callbackURLs: merged.callbackURLs ?? [],
    logoutCallbackURLs: merged.logoutCallbackURLs ?? [],
    isPublic: merged.isPublic,
    pkceEnabled: merged.pkceEnabled,
    requiresReauthentication: merged.requiresReauthentication ?? false,
    requiresPushedAuthorizationRequests: merged.requiresPushedAuthorizationRequests ?? false,
    skipConsent: merged.skipConsent ?? false,
    launchURL: merged.launchURL ?? null,
    // Pocket ID only enforces allowed groups when this flag is set.
    isGroupRestricted: true,
    accessTokenDurationMinutes: merged.accessTokenDurationMinutes ?? 0,
    refreshTokenDurationMinutes: merged.refreshTokenDurationMinutes ?? 0,
    credentials: { federatedIdentities: merged.credentials?.federatedIdentities ?? [] },
  };
}

// Updates a client without discarding settings an instructor changed in
// Pocket ID admin, then re-applies the allowed groups (PUT clears them).
async function updateClient(origin: string, clientId: string, overrides: Partial<PocketClient>, groupIds: string[]): Promise<void> {
  const current = await pocketApi<PocketClient>(origin, `/oidc/clients/${clientId}`);
  await pocketApi(origin, `/oidc/clients/${clientId}`, {
    method: 'PUT',
    body: JSON.stringify(clientUpdateBody(current, overrides)),
  });
  await pause();
  await restrictClientToGroups(origin, clientId, groupIds);
}

// Allowed groups only take effect together with isGroupRestricted; clients
// created by earlier versions of this template lack the flag, so set it here.
async function restrictClientToGroups(origin: string, clientId: string, groupIds: string[]): Promise<void> {
  const current = await pocketApi<PocketClient>(origin, `/oidc/clients/${clientId}`);
  if (!current.isGroupRestricted) {
    await pocketApi(origin, `/oidc/clients/${clientId}`, {
      method: 'PUT',
      body: JSON.stringify(clientUpdateBody(current, {})),
    });
    await pause();
  }
  await pocketApi(origin, `/oidc/clients/${clientId}/allowed-user-groups`, {
    method: 'PUT',
    body: JSON.stringify({ userGroupIds: groupIds }),
  });
  await pause();
}

// Every group allowed to use the mode's client.
async function attendeeGroupIds(origin: string, mode: WorkshopMode): Promise<string[]> {
  const names = mode === 'vercel-team' ? [workshopGroupName, vercelMemberGroupName, vercelOwnerGroupName] : [workshopGroupName];
  const ids: string[] = [];
  for (const name of names) ids.push((await ensureGroup(origin, name)).id);
  return ids;
}

// App mode: a public PKCE client for whatever the room is building.
async function ensureAppClient(origin: string, groupId: string): Promise<void> {
  if (!(await clientExists(origin, 'workshop-app'))) {
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
        isGroupRestricted: true,
      }),
    });
    await pause();
  }
  await restrictClientToGroups(origin, 'workshop-app', [groupId]);
}

type ClientSecretCreated = { id: string; secret: string };

// Attendees sign in to Vercel at this URL; with a team slug it also becomes
// the client's launch URL, so Pocket ID shows a "Vercel" tile after signup.
export function vercelSignInUrl(teamSlug: string | null): string {
  return teamSlug ? `https://vercel.com/login?saml=${encodeURIComponent(teamSlug)}` : 'https://vercel.com/login';
}

const vercelSsoClientBody = (callbackUrl: string, teamSlug: string | null) => ({
  name: 'Vercel',
  description: 'Sign in to the Vercel team',
  callbackURLs: [callbackUrl],
  logoutCallbackURLs: [],
  isPublic: false,
  pkceEnabled: true,
  skipConsent: true,
  isGroupRestricted: true,
  launchURL: teamSlug ? vercelSignInUrl(teamSlug) : null,
});

// Vercel team mode: a confidential client for Vercel's SSO connection plus a
// stored secret. Idempotent; an existing connection is left untouched.
async function ensureVercelSsoClient(origin: string, groupIds: string[]): Promise<VercelConnection> {
  const existing = await getVercelConnection(workshopName);
  if (!(await clientExists(origin, vercelSsoClientId))) {
    await pocketApi(origin, '/oidc/clients', {
      method: 'POST',
      body: JSON.stringify({
        id: vercelSsoClientId,
        ...vercelSsoClientBody(existing?.callbackUrl ?? defaultVercelCallbackUrl, existing?.teamSlug ?? null),
      }),
    });
    await pause();
  }
  await restrictClientToGroups(origin, vercelSsoClientId, groupIds);
  if (existing) return existing;
  const created = await pocketApi<ClientSecretCreated>(origin, `/oidc/clients/${vercelSsoClientId}/secrets`, {
    method: 'POST',
  });
  await pause();
  const connection = {
    clientId: vercelSsoClientId,
    clientSecret: created.secret,
    callbackUrl: defaultVercelCallbackUrl,
    teamSlug: null,
    scimProviderId: null,
    scimEndpoint: null,
  };
  await saveVercelConnection(workshopName, connection);
  return { ...connection, lastSyncError: null, lastSyncAttemptAt: null, updatedAt: new Date() };
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

// Directory Sync matches people by email. The instructor's email decides
// which Vercel account stays Owner: instructor@<domain> for an EMU team, or
// the instructor's own Vercel login email to keep an existing account.
export function defaultInstructorEmail(domain: string): string {
  return `instructor@${domain}`;
}

async function setInstructorEmail(origin: string, admin: User, email: string): Promise<void> {
  if ((admin.email ?? '').toLowerCase() === email.toLowerCase()) return;
  await pocketApi(origin, `/users/${admin.id}`, {
    method: 'PUT',
    body: JSON.stringify({
      username: admin.username,
      firstName: admin.firstName || 'Workshop',
      lastName: admin.lastName || 'Instructor',
      displayName: admin.displayName ?? '',
      email,
      emailVerified: true,
      isAdmin: true,
    }),
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
// Always over 15 minutes: Pocket ID's code page only accepts the 12-character
// format unless emailed login codes are enabled, so 6-character codes cannot
// be typed in at /lc in this configuration.
export const loginLinkTtl = '1h';

export type LoginLink = { code: string; loginUrl: string; codeEntryUrl: string; ttl: string };

async function mintLoginLink(
  origin: string,
  publicOrigin: string,
  userId: string,
  redirectPath: string,
  ttl: string = loginLinkTtl,
): Promise<LoginLink> {
  const { token } = await pocketApi<{ token: string }>(origin, `/users/${userId}/one-time-access-token`, {
    method: 'POST',
    body: JSON.stringify({ ttl }),
  });
  const url = new URL('/login/alternative/code', publicOrigin);
  url.searchParams.set('code', token);
  url.searchParams.set('redirect', redirectPath);
  // /lc is Pocket ID's short alias for the manual code-entry page.
  return { code: token, loginUrl: url.toString(), codeEntryUrl: `${publicOrigin}/lc`, ttl };
}

async function mintSignupTokens(origin: string, groupIds: string[], tokenCount: number): Promise<string[]> {
  const tokens: string[] = [];
  for (let index = 0; index < tokenCount; index += 1) {
    const result = await pocketApi<{ token: string }>(origin, '/signup-tokens', {
      method: 'POST',
      body: JSON.stringify({ ttl: tokenTtl, usageLimit: tokenUsageLimit, userGroupIds: groupIds }),
    });
    tokens.push(result.token);
    await pause();
  }
  return tokens;
}

export class PrepareInProgressError extends Error {
  constructor() {
    super('The workshop is already being prepared. This takes a minute or two; the console updates when it finishes.');
  }
}

export async function setupWorkshop(requestOrigin: string): Promise<WorkshopSetup> {
  const existing = await getWorkshopSetup(workshopName);
  if (existing) return existing;
  if (!(await acquirePrepareLease(workshopName))) throw new PrepareInProgressError();
  try {
    return await provisionWorkshop(requestOrigin);
  } catch (error) {
    await releasePrepareLease(workshopName).catch(() => undefined);
    throw error;
  }
}

async function provisionWorkshop(requestOrigin: string): Promise<WorkshopSetup> {
  const options = await getWorkshopOptions(workshopName);
  if (options.mode === 'vercel-team' && !options.emailDomain) {
    throw new Error('Vercel team mode needs the verified email domain. Set it before preparing the workshop.');
  }
  const tokenCount = signupTokenCount(options.expectedAttendees);
  const origin = await getKnownSandboxOrigin();
  const publicOrigin = appUrl(requestOrigin);
  await configureSignups(origin, options);
  const admin = await ensureAdmin(origin);
  const group = await ensureGroup(origin, workshopGroupName);
  // Every group a signup token assigns. In Vercel team mode attendees also
  // join the role group so Directory Sync maps them to Member.
  const attendeeGroupIds = [group.id];
  if (options.mode === 'vercel-team') {
    const memberGroup = await ensureGroup(origin, vercelMemberGroupName);
    attendeeGroupIds.push(memberGroup.id);
    // The instructor is pushed too, as an Owner, so confirming Directory
    // Sync never locks the instructor out of the team.
    const ownerGroup = await ensureGroup(origin, vercelOwnerGroupName);
    await addAdminToGroup(origin, ownerGroup.id, admin.id);
    await setInstructorEmail(origin, admin, options.ownerEmail ?? defaultInstructorEmail(options.emailDomain ?? ''));
    await ensureVercelSsoClient(origin, [...attendeeGroupIds, ownerGroup.id]);
  } else {
    await ensureAppClient(origin, group.id);
  }
  await addAdminToGroup(origin, group.id, admin.id);
  // Stored for schema compatibility only; the console mints a fresh link on demand.
  const { loginUrl: adminLoginUrl } = await mintLoginLink(origin, publicOrigin, admin.id, '/settings/admin/users');
  await pause();
  const signupTokens = await mintSignupTokens(origin, attendeeGroupIds, tokenCount);
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
  idle: false;
  attendees: Attendee[];
  page: number;
  totalPages: number;
  totalItems: number;
};

export type AttendeesIdle = { idle: true };

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
// Does not wake a stopped Sandbox unless asked to.
export async function listAttendees(search: string, page: number, wake: boolean): Promise<AttendeePage | AttendeesIdle> {
  if (!wake) {
    const state = await getLifecycleState(workshopName);
    if (state.status !== 'running') return { idle: true };
  }
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
    idle: false,
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

// ---------------------------------------------------------------------------
// Vercel team mode: what the instructor pastes into Vercel, and the SCIM push.

export type VercelTeamStatus = {
  issuer: string;
  discoveryUrl: string;
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  teamSlug: string | null;
  signInUrl: string;
  emailDomain: string;
  memberGroup: string;
  ownerGroup: string;
  workshopGroup: string;
  // Email Directory Sync uses to keep the instructor an Owner.
  instructorEmail: string | null;
  scim: {
    endpoint: string;
    lastSyncedAt: string | null;
    lastAttemptAt: string | null;
    // Instructor-readable summary of the most recent failed push, if any.
    lastError: string | null;
  } | null;
  sandboxRunning: boolean;
};

// Thrown for bad instructor input; routes answer 400 instead of 500.
export class InvalidInputError extends Error {}

// Pocket ID reports SCIM failures as a generic 500; say something useful.
function describeSyncError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/scim\/service-provider\/[^/]+\/sync returned 5\d\d/.test(message)) {
    return 'Pocket ID could not complete the push. Check that the SCIM endpoint and bearer token are exactly what Vercel showed, and that Directory Sync is still in setup on the team.';
  }
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}

async function runScimSync(origin: string, providerId: string): Promise<void> {
  try {
    await pocketApi(origin, `/scim/service-provider/${providerId}/sync`, { method: 'POST' });
    await recordSyncAttempt(workshopName, null);
  } catch (error) {
    await recordSyncAttempt(workshopName, describeSyncError(error)).catch(() => undefined);
    throw new Error(describeSyncError(error));
  }
}

type ScimServiceProvider = { id: string; endpoint: string; token: string; lastSyncedAt: string | null };

async function requireVercelMode(): Promise<{ options: WorkshopOptions; connection: VercelConnection }> {
  const options = await getWorkshopOptions(workshopName);
  if (options.mode !== 'vercel-team') throw new Error('This workshop is not in Vercel team mode');
  const connection = await getVercelConnection(workshopName);
  if (!connection) throw new Error('Prepare the workshop first; the Vercel SSO client does not exist yet');
  return { options, connection };
}

// Reads the stored connection and, when Pocket ID is running, the SCIM
// provider's last sync time. Never wakes an idle Sandbox.
export async function getVercelTeamStatus(requestOrigin: string): Promise<VercelTeamStatus> {
  const { options, connection } = await requireVercelMode();
  const issuer = appUrl(requestOrigin);
  const state = await getLifecycleState(workshopName);
  let scim: VercelTeamStatus['scim'] = connection.scimEndpoint
    ? {
        endpoint: connection.scimEndpoint,
        lastSyncedAt: null,
        lastAttemptAt: connection.lastSyncAttemptAt?.toISOString() ?? null,
        lastError: connection.lastSyncError,
      }
    : null;
  if (scim && state.status === 'running' && connection.scimProviderId) {
    try {
      const origin = await getKnownSandboxOrigin();
      const provider = await pocketApi<ScimServiceProvider>(origin, `/oidc/clients/${vercelSsoClientId}/scim-service-provider`);
      scim = { ...scim, endpoint: provider.endpoint, lastSyncedAt: provider.lastSyncedAt };
    } catch {
      // Status is decorative; the stored endpoint is still shown.
    }
  }
  let instructorEmail: string | null = null;
  if (state.status === 'running') {
    try {
      const origin = await getKnownSandboxOrigin();
      const found = await pocketApi<Paginated<User>>(origin, '/users?search=instructor&pagination[limit]=5');
      instructorEmail = found.data?.find((user) => user.username === 'instructor')?.email ?? null;
    } catch {
      // Decorative.
    }
  }
  return {
    issuer,
    discoveryUrl: `${issuer}/.well-known/openid-configuration`,
    clientId: connection.clientId,
    clientSecret: connection.clientSecret,
    callbackUrl: connection.callbackUrl,
    teamSlug: connection.teamSlug,
    signInUrl: vercelSignInUrl(connection.teamSlug),
    emailDomain: options.emailDomain ?? '',
    memberGroup: vercelMemberGroupName,
    ownerGroup: vercelOwnerGroupName,
    workshopGroup: workshopGroupName,
    instructorEmail,
    scim,
    sandboxRunning: state.status === 'running',
  };
}

// Points Pocket ID's SCIM provisioning at Vercel's Directory Sync endpoint
// and runs a first sync. Replaces any previous endpoint or token.
export async function connectVercelDirectorySync(endpoint: string, token: string): Promise<void> {
  const { connection } = await requireVercelMode();
  const trimmedEndpoint = endpoint.trim().replace(/\/$/, '');
  const trimmedToken = token.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmedEndpoint);
  } catch {
    throw new InvalidInputError('The SCIM endpoint must be a full https:// URL');
  }
  if (parsed.protocol !== 'https:') throw new InvalidInputError('The SCIM endpoint must use https');
  if (!trimmedToken) throw new InvalidInputError('The SCIM bearer token is required');

  const origin = await getKnownSandboxOrigin();
  const body = JSON.stringify({ endpoint: trimmedEndpoint, token: trimmedToken, oidcClientId: vercelSsoClientId });
  let providerId = connection.scimProviderId;
  if (providerId) {
    await pocketApi(origin, `/scim/service-provider/${providerId}`, { method: 'PUT', body });
  } else {
    const created = await pocketApi<ScimServiceProvider>(origin, '/scim/service-provider', { method: 'POST', body });
    providerId = created.id;
  }
  // The endpoint and token are kept even if the first push fails, so the
  // instructor fixes one thing instead of retyping both; the failure is
  // reported next to the connection.
  await saveVercelConnection(workshopName, { ...connection, scimProviderId: providerId, scimEndpoint: trimmedEndpoint });
  await runScimSync(origin, providerId);
}

export async function syncVercelDirectory(): Promise<void> {
  const { connection } = await requireVercelMode();
  if (!connection.scimProviderId) throw new InvalidInputError('Directory Sync is not connected yet');
  const origin = await getKnownSandboxOrigin();
  await runScimSync(origin, connection.scimProviderId);
}

// Called by the proxy after every successful signup in Vercel team mode.
// Waits briefly, then pushes unless another signup's push already covered
// this one: a user created at time t is included by any push at or after t,
// and its own attempt at t+delay is skipped only when such a push happened.
// Pocket ID's own five-minute debounce remains the backstop.
const autoSyncDelayMs = 15_000;

export async function autoSyncAfterSignup(): Promise<void> {
  try {
    const options = await getWorkshopOptions(workshopName);
    if (options.mode !== 'vercel-team') return;
    const connection = await getVercelConnection(workshopName);
    if (!connection?.scimProviderId) return;
    await sleep(autoSyncDelayMs);
    if (!(await acquireAutoSyncSlot(workshopName, autoSyncDelayMs / 1000))) return;
    const origin = await getKnownSandboxOrigin();
    await runScimSync(origin, connection.scimProviderId);
  } catch (error) {
    console.error('Automatic Directory Sync push failed', error);
  }
}

// Issues a new client secret and forgets the old one. Vercel's SSO dialog
// must be updated with the new value afterwards.
export async function rotateVercelClientSecret(): Promise<string> {
  const { connection } = await requireVercelMode();
  const origin = await getKnownSandboxOrigin();
  const existing = await pocketApi<Array<{ id: string }>>(origin, `/oidc/clients/${vercelSsoClientId}/secrets`);
  const created = await pocketApi<ClientSecretCreated>(origin, `/oidc/clients/${vercelSsoClientId}/secrets`, { method: 'POST' });
  for (const secret of existing) {
    await pocketApi(origin, `/oidc/clients/${vercelSsoClientId}/secrets/${secret.id}`, { method: 'DELETE' });
  }
  await saveVercelConnection(workshopName, { ...connection, clientSecret: created.secret });
  return created.secret;
}

// Adjusts the Vercel client. callbackUrl pins the exact login redirect URL
// from Vercel's SSO dialog instead of the wildcard; teamSlug sets the launch
// URL so attendees get a Vercel tile and the console can show the sign-in link.
export async function updateVercelClient(patch: { callbackUrl?: string; teamSlug?: string | null }): Promise<void> {
  const { connection } = await requireVercelMode();
  let callbackUrl = connection.callbackUrl;
  if (patch.callbackUrl !== undefined) {
    callbackUrl = patch.callbackUrl.trim();
    let parsed: URL;
    try {
      parsed = new URL(callbackUrl.replace(/\*/g, 'x'));
    } catch {
      throw new InvalidInputError('The redirect URL must be a full https:// URL');
    }
    if (parsed.protocol !== 'https:') throw new InvalidInputError('The redirect URL must use https');
  }
  let teamSlug = connection.teamSlug;
  if (patch.teamSlug !== undefined) {
    const slug = (patch.teamSlug ?? '').trim().toLowerCase();
    if (slug && !/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(slug)) {
      throw new InvalidInputError('Enter the team slug as it appears in vercel.com/<slug>');
    }
    teamSlug = slug || null;
  }
  const origin = await getKnownSandboxOrigin();
  const groupIds = await attendeeGroupIds(origin, 'vercel-team');
  await updateClient(
    origin,
    vercelSsoClientId,
    { callbackURLs: [callbackUrl], launchURL: teamSlug ? vercelSignInUrl(teamSlug) : null },
    groupIds,
  );
  await saveVercelConnection(workshopName, { ...connection, callbackUrl, teamSlug });
}

// Changes which Vercel account the instructor's Pocket ID identity maps to.
export async function updateInstructorEmail(email: string): Promise<void> {
  await requireVercelMode();
  const trimmed = email.trim().toLowerCase();
  if (!emailPattern.test(trimmed)) throw new InvalidInputError('Enter a full email address');
  const origin = await getKnownSandboxOrigin();
  const found = await pocketApi<Paginated<User>>(origin, '/users?search=instructor&pagination[limit]=5');
  const admin = found.data?.find((user) => user.username === 'instructor');
  if (!admin) throw new Error("The 'instructor' user does not exist yet; prepare the workshop first");
  await setInstructorEmail(origin, admin, trimmed);
}

// ---------------------------------------------------------------------------
// Signup email policy, applied by the reverse proxy on POST /api/signup.

export type SignupEmailPolicy = { domain: string } | null;

export async function getSignupEmailPolicy(): Promise<SignupEmailPolicy> {
  const options = await getWorkshopOptions(workshopName);
  return options.mode === 'vercel-team' && options.emailDomain ? { domain: options.emailDomain } : null;
}

// Rewrites a signup body so the email is always <username>@<domain>. Attendees
// may leave email blank or type anything; Enterprise Managed Users only
// accepts the team's verified domain, so the proxy decides.
export function applySignupEmailPolicy(body: string, policy: { domain: string }): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return body;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return body;
  const username = typeof parsed.username === 'string' ? parsed.username.trim() : '';
  if (!username) return body;
  const email = typeof parsed.email === 'string' ? parsed.email.trim().toLowerCase() : '';
  const suffix = `@${policy.domain.toLowerCase()}`;
  if (email && email.endsWith(suffix)) return JSON.stringify({ ...parsed, email });
  // Usernames may contain '@' and '.'; keep only what makes a valid local part.
  const local = username.toLowerCase().split('@')[0].replace(/[^a-z0-9._-]/g, '') || 'attendee';
  return JSON.stringify({ ...parsed, email: `${local}${suffix}` });
}

// Vercel's SSO expects a name claim; attendees who skip both name fields get
// their username as first name so the account is not blank in Vercel.
export function applySignupNamePolicy(body: string): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return body;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return body;
  const username = typeof parsed.username === 'string' ? parsed.username.trim() : '';
  const firstName = typeof parsed.firstName === 'string' ? parsed.firstName.trim() : '';
  const lastName = typeof parsed.lastName === 'string' ? parsed.lastName.trim() : '';
  if (!username || firstName || lastName) return body;
  return JSON.stringify({ ...parsed, firstName: username.slice(0, 50) });
}

const domainPattern = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmailDomain(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const domain = input.trim().toLowerCase().replace(/^@/, '');
  return domainPattern.test(domain) ? domain : null;
}

export const attendeeChoices = [50, 100, 250, 500, 1000];

export class InvalidOptionsError extends Error {}

// Validates the options body shared by /setup and the pre-Prepare editor.
export function parseWorkshopOptions(body: unknown): WorkshopOptions {
  const input = (body ?? {}) as Partial<Record<keyof WorkshopOptions, unknown>>;
  const attendees = Number(input.expectedAttendees);
  const mode: WorkshopMode = input.mode === 'vercel-team' ? 'vercel-team' : 'app';
  const emailDomain = mode === 'vercel-team' ? normalizeEmailDomain(input.emailDomain) : null;
  if (mode === 'vercel-team' && !emailDomain) {
    throw new InvalidOptionsError('Enter the email domain your Vercel team has verified, for example workshop.example.com');
  }
  let ownerEmail: string | null = null;
  if (mode === 'vercel-team' && typeof input.ownerEmail === 'string' && input.ownerEmail.trim()) {
    ownerEmail = input.ownerEmail.trim().toLowerCase();
    if (!emailPattern.test(ownerEmail)) throw new InvalidOptionsError('Enter your Vercel login email as a full address, or leave it blank');
  }
  return {
    expectedAttendees: attendeeChoices.includes(attendees) ? attendees : defaultWorkshopOptions.expectedAttendees,
    requireEmail: mode === 'app' && input.requireEmail === true,
    mode,
    emailDomain,
    ownerEmail,
  };
}
