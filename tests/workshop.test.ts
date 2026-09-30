import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

// Execute the real store's SQL in disposable Postgres, never the .env database.
const state = vi.hoisted(() => ({ db: null as PGlite | null, wakes: 0 }));
vi.mock('@neondatabase/serverless', () => ({
  neon: () => async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.reduce((sql, part, index) => sql + (index ? `$${index}` : '') + part, '');
    return (await state.db!.query(query, values)).rows;
  },
}));
vi.mock('../lib/sandbox-control', () => ({
  getKnownSandboxOrigin: async () => { state.wakes++; return 'http://pocket.test'; },
}));
vi.mock('../lib/lifecycle-store', () => ({ getLifecycleState: async () => ({ status: 'stopped' }) }));

let workshop: typeof import('../lib/workshop');
let store: typeof import('../lib/workshop-store');
let route: typeof import('../app/api/workshop/passport/route');
let calls: Array<{ path: string; method: string; body: Record<string, unknown> }>;
let clients: Map<string, Record<string, unknown>>;
let groups: Map<string, { id: string; name: string; friendlyName: string; users: unknown[] }>;
let users: Array<Record<string, unknown>>;
let failToken = false;
let failLookup = false;
let secrets = 0;

beforeAll(async () => {
  vi.stubEnv('WORKSHOP_SETUP_DELAY_MS', '0');
  vi.stubEnv('CONTROLLER_DATABASE_URL', 'postgresql://unused:unused@localhost/isolated');
  vi.stubEnv('ENCRYPTION_KEY', 'local-test-encryption');
  vi.stubEnv('STATIC_API_KEY', 'local-test-api');
  vi.stubEnv('WORKSHOP_ADMIN_SECRET', 'local-test-instructor');
  vi.stubEnv('APP_URL', 'https://idp.test');
  workshop = await import('../lib/workshop');
  store = await import('../lib/workshop-store');
  route = await import('../app/api/workshop/passport/route');
});

beforeEach(async () => {
  await state.db?.close();
  state.db = new PGlite();
  state.wakes = 0;
  calls = []; clients = new Map(); groups = new Map(); users = [];
  failToken = false; failLookup = false; secrets = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    expect(u.origin).toBe('http://pocket.test');
    const path = u.pathname.replace('/api', '');
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : {};
    calls.push({ path, method, body });
    if (path === '/application-configuration/all') return Response.json([]);
    if (path === '/application-configuration') return Response.json({});
    if (path === '/users') {
      if (method === 'GET') return Response.json({ data: users });
      const user = { ...body, id: `user-${users.length}` }; users.push(user); return Response.json(user);
    }
    if (path === '/user-groups') {
      if (method === 'GET') return Response.json({ data: [...groups.values()] });
      const group = { ...body, id: `group-${groups.size}`, users: [] }; groups.set(group.id, group); return Response.json(group);
    }
    if (path.startsWith('/user-groups/')) {
      const group = groups.get(path.split('/')[2])!;
      if (method === 'GET') return Response.json(group);
      if (path.endsWith('/users')) group.users = body.userIds.map((id: string) => ({ id }));
      return Response.json({});
    }
    if (path === '/oidc/clients' && method === 'POST') {
      clients.set(body.id, body); return Response.json(body);
    }
    if (path.startsWith('/oidc/clients/')) {
      const clientId = path.split('/')[3];
      if (path.endsWith('/secrets')) return Response.json({ id: `secret-${++secrets}`, secret: `test-secret-${secrets}` });
      if (path.endsWith('/allowed-user-groups')) { clients.get(clientId)!.groups = body.userGroupIds; return Response.json({}); }
      if (method === 'GET') {
        if (failLookup) return Response.json({ secret: 'upstream-sensitive-value' }, { status: 503 });
        return Response.json(clients.get(clientId) ?? {}, { status: clients.has(clientId) ? 200 : 404 });
      }
      clients.set(clientId, { ...body, id: clientId }); return Response.json({});
    }
    if (path.endsWith('/one-time-access-token')) return Response.json({ token: 'test-login' });
    if (path.startsWith('/users/') && method === 'PUT') return Response.json(body);
    if (path === '/signup-tokens') {
      if (failToken) { failToken = false; return Response.json({}, { status: 503 }); }
      return Response.json({ token: `token-${calls.length}` });
    }
    throw new Error(`Unhandled test request: ${method} ${path}`);
  }));
});

afterAll(async () => { await state.db?.close(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

async function options(mode: 'app' | 'passport' | 'vercel-team', expectedAttendees = 100) {
  await store.saveWorkshopOptions(workshop.getWorkshopName(), workshop.parseWorkshopOptions({ mode, expectedAttendees, emailDomain: 'event.example.com' }));
}

describe('workshop provisioning', () => {
  it.each(['app', 'passport', 'vercel-team'] as const)('persists and provisions %s without crossing modes', async mode => {
    await options(mode);
    expect((await store.getWorkshopOptions(workshop.getWorkshopName())).mode).toBe(mode);
    const setup = await workshop.setupWorkshop('https://idp.test');
    expect(setup.capacity).toBe(200);
    expect(setup.joinUrl).toBe('https://idp.test/join');
    expect(users).toHaveLength(1); // Only instructor; no pre-created attendees.
    const clientId = mode === 'passport' ? 'workshop-passport' : mode === 'app' ? 'workshop-app' : 'vercel-sso';
    expect([...clients.keys()]).toEqual([clientId]);
    expect(clients.get(clientId)).toMatchObject({ isPublic: mode === 'app', pkceEnabled: true, isGroupRestricted: true });
    expect(clients.get(clientId)!.groups).toHaveLength(mode === 'vercel-team' ? 3 : 1);
    expect(secrets).toBe(mode === 'app' ? 0 : 1);
    if (mode === 'passport') {
      expect(clients.get(clientId)!.callbackURLs).toEqual(['https://connect.vercel.com/callback']);
      expect(await store.getVercelConnection(workshop.getWorkshopName())).toBeNull();
    }
  });

  it('creates ten additional tokens for 1000 attendees, without creating attendee accounts', async () => {
    await options('passport', 1000);
    expect((await workshop.setupWorkshop('https://idp.test')).capacity).toBe(1200);
    const tokens = calls.filter(c => c.path === '/signup-tokens');
    expect(tokens).toHaveLength(12);
    expect(tokens.every(c => c.body.usageLimit === 100 && c.body.ttl === '72h')).toBe(true);
    expect(workshop.signupTokenCount(100)).toBe(2);
    expect(users).toHaveLength(1);
  });

  it('keeps a saved Passport secret when preparation fails later and is retried', async () => {
    await options('passport'); failToken = true;
    await expect(workshop.setupWorkshop('https://idp.test')).rejects.toThrow('503');
    const before = await store.getPassportConnection(workshop.getWorkshopName());
    expect(before?.clientSecret).toBe('test-secret-1');
    await workshop.setupWorkshop('https://idp.test');
    expect(await store.getPassportConnection(workshop.getWorkshopName())).toEqual(before);
    expect(secrets).toBe(1);
    const count = calls.length;
    await workshop.setupWorkshop('https://idp.test');
    expect(calls).toHaveLength(count);
  });

  it('does not recreate a prepared client whose credentials would no longer work', async () => {
    await options('passport'); failToken = true;
    await expect(workshop.setupWorkshop('https://idp.test')).rejects.toThrow();
    clients.clear();
    await expect(workshop.setupWorkshop('https://idp.test')).rejects.toThrow('client is missing');
    expect(secrets).toBe(1);
  });

  it.each(['app', 'passport', 'vercel-team'] as const)('locks attendee self-service account edits only in Vercel team mode (%s)', async mode => {
    await options(mode);
    await workshop.setupWorkshop('https://idp.test');
    const saved = calls.find(c => c.path === '/application-configuration' && c.method === 'PUT')!.body;
    expect(saved.emailsVerified).toBe(mode === 'vercel-team' ? 'true' : 'false');
    expect(saved.allowOwnAccountEdit).toBe(mode === 'vercel-team' ? 'false' : undefined);
  });

  it.each(['passport', 'vercel-team'] as const)('renews signup with fresh tokens behind the same link (%s)', async mode => {
    await options(mode, 250);
    const first = await workshop.setupWorkshop('https://idp.test');
    const name = workshop.getWorkshopName();
    expect(await store.takeNextSignupToken(name)).toBe(first.signupTokens[0]);
    const tokenCalls = () => calls.filter(c => c.path === '/signup-tokens');
    const before = tokenCalls().length;
    const renewed = await workshop.renewSignupTokens();
    expect(tokenCalls()).toHaveLength(before + first.signupTokens.length);
    // Attendee groups only: the owner group never comes from a signup token.
    const ownerGroup = [...groups.values()].find(g => g.name === 'vercel-role-owner');
    for (const call of tokenCalls().slice(before)) {
      expect(call.body).toMatchObject({ ttl: '72h', usageLimit: 100 });
      expect(call.body.userGroupIds).toHaveLength(mode === 'vercel-team' ? 2 : 1);
      if (ownerGroup) expect(call.body.userGroupIds).not.toContain(ownerGroup.id);
    }
    expect(renewed.signupTokens).toHaveLength(first.signupTokens.length);
    expect(renewed.signupTokens.some(t => first.signupTokens.includes(t))).toBe(false);
    expect(renewed.capacity).toBe(first.capacity);
    expect(renewed.joinUrl).toBe(first.joinUrl);
    const saved = await store.getWorkshopSetup(name);
    expect(saved?.signupTokens).toEqual(renewed.signupTokens);
    expect(saved!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 71 * 60 * 60_000);
    expect(await store.takeNextSignupToken(name)).toBe(renewed.signupTokens[0]);
    // The lease is released, so a second renewal works.
    await expect(workshop.renewSignupTokens()).resolves.toBeTruthy();
  });

  it('counts signups across every issued token, beyond one page of the provider list', async () => {
    await options('passport', 1000);
    const first = await workshop.setupWorkshop('https://idp.test');
    const renewed = await workshop.renewSignupTokens();
    // 24 workshop tokens plus 86 others with one signup each: two pages at the 100-per-page cap.
    const all = [...first.signupTokens, ...renewed.signupTokens, ...Array.from({ length: 86 }, (_, i) => `other-${i}`)];
    const listFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const u = new URL(String(url));
      if (u.pathname !== '/api/signup-tokens' || (init?.method ?? 'GET') !== 'GET') return listFetch(url as string, init);
      const page = Number(u.searchParams.get('pagination[page]'));
      const slice = all.slice((page - 1) * 100, page * 100).map(token => ({ token, usageLimit: 100, usageCount: 1 }));
      return Response.json({ data: slice, pagination: { totalPages: 2, currentPage: page } });
    });
    vi.doMock('../lib/lifecycle-store', () => ({ getLifecycleState: async () => ({ status: 'running' }) }));
    vi.resetModules();
    const fresh = await import('../lib/workshop');
    expect((await fresh.getSignupProgress()).used).toBe(24);
    vi.doUnmock('../lib/lifecycle-store');
  });

  it('refuses to renew signup before the workshop is prepared', async () => {
    await options('app');
    await expect(workshop.renewSignupTokens()).rejects.toThrow(workshop.InvalidInputError);
  });

  it('does not treat provider outages as a missing client or leak provider error bodies', async () => {
    await options('passport'); failLookup = true;
    await expect(workshop.setupWorkshop('https://idp.test')).rejects.toThrow('returned 503');
    expect(clients.size).toBe(0);
    expect(secrets).toBe(0);
  });
});

describe('Passport credentials endpoint', () => {
  const request = (password?: string) => new Request('https://idp.test/api/workshop/passport', {
    headers: password ? { authorization: `Basic ${Buffer.from(`:${password}`).toString('base64')}` } : {},
  });
  it.each([undefined, 'wrong'])('rejects unauthenticated credentials (%s)', async password => {
    const response = await route.GET(request(password));
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'unauthorized' });
    expect(state.wakes).toBe(0);
  });
  it('returns saved credentials only to the instructor without waking Pocket ID', async () => {
    await options('passport'); await workshop.setupWorkshop('https://idp.test');
    state.wakes = 0;
    const response = await route.GET(request('local-test-instructor'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ clientSecret: 'test-secret-1', issuer: 'https://idp.test', callbackUrl: 'https://connect.vercel.com/callback' });
    expect(state.wakes).toBe(0);
  });
  it('distinguishes unprepared and wrong-mode workshops', async () => {
    await options('passport');
    expect(await (await route.GET(request('local-test-instructor'))).json()).toBeNull();
    await options('app');
    expect((await route.GET(request('local-test-instructor'))).status).toBe(400);
  });
  it('does not include a database error or credentials in failure responses', async () => {
    vi.spyOn(state.db!, 'query').mockRejectedValueOnce(new Error('postgresql://private-secret'));
    const response = await route.GET(request('local-test-instructor'));
    expect(response.status).toBe(500);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).not.toContain('private-secret');
  });
});

it('keeps the Sandbox origin, lease, and startup error out of the public status', async () => {
  const { publicControllerStatus } = await vi.importActual<typeof import('../lib/sandbox-control')>('../lib/sandbox-control');
  const full = {
    name: 'pocket-id', status: 'failed' as const, sandboxStatus: 'stopped', lastRequestAt: new Date(0), sessionExpiresAt: null, failed: true,
    origin: 'https://sb-private.vercel.run', leaseOwner: 'owner', leaseUntil: new Date(0), lastError: 'internal detail',
  };
  const shown = publicControllerStatus(full);
  expect(shown).toEqual({ name: 'pocket-id', status: 'failed', sandboxStatus: 'stopped', lastRequestAt: new Date(0), sessionExpiresAt: null, failed: true });
  expect(JSON.stringify(shown)).not.toContain('vercel.run');
});

it('validates Passport explicitly, preserves legacy defaults, and rejects unknown modes', () => {
  expect(workshop.parseWorkshopOptions({}).mode).toBe('app');
  expect(workshop.parseWorkshopOptions({ mode: 'passport', requireEmail: true, emailDomain: 'ignored.com' })).toMatchObject({ mode: 'passport', requireEmail: true, emailDomain: null });
  expect(() => workshop.parseWorkshopOptions({ mode: 'typo' })).toThrow(workshop.InvalidOptionsError);
  expect(() => workshop.parseWorkshopOptions({ mode: 'vercel-team' })).toThrow(workshop.InvalidOptionsError);
});
