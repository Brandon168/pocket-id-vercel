import { beforeEach, expect, it, vi } from 'vitest';

// The reverse proxy when Pocket ID dies under a cached Sandbox origin
// (seen live: a killed process gave ~4 minutes of 502s before this fix).
const state = vi.hoisted(() => ({ healthy: false, invalidations: 0, lookups: 0, upstream: [] as string[] }));
vi.mock('next/server', () => ({ after: () => undefined }));
vi.mock('@/lib/secrets', () => ({ isSetupComplete: async () => true }));
vi.mock('@/lib/workshop', () => ({
  applySignupEmailPolicy: (body: string) => body,
  applySignupNamePolicy: (body: string) => body,
  autoSyncAfterSignup: async () => undefined,
  getSignupEmailPolicy: async () => null,
}));
vi.mock('@/lib/sandbox-control', () => ({
  // After an invalidation the real lookup health-checks and restarts Pocket ID.
  getKnownSandboxOrigin: async () => { state.lookups++; if (state.invalidations) state.healthy = true; return 'https://sb.test'; },
  invalidateKnownSandboxOrigin: () => { state.invalidations++; },
  recordProxyActivity: async () => undefined,
}));

let route: typeof import('../app/[[...path]]/route');

beforeEach(async () => {
  Object.assign(state, { healthy: false, invalidations: 0, lookups: 0, upstream: [] });
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    const u = new URL(String(url));
    state.upstream.push(u.pathname);
    if (!state.healthy) return new Response('bad gateway', { status: 502 });
    return u.pathname === '/healthz' ? new Response(null, { status: 204 }) : new Response('ok', { status: 200 });
  }));
  route = await import('../app/[[...path]]/route');
});

it('restarts Pocket ID and retries a GET when the cached origin answers 502', async () => {
  const response = await route.GET(new Request('https://idp.test/login'));
  expect(response.status).toBe(200);
  expect(state.invalidations).toBe(1);
  expect(state.upstream).toEqual(['/login', '/healthz', '/login']);
});

it('does not replay a POST after a restart', async () => {
  const response = await route.POST(new Request('https://idp.test/api/signup', { method: 'POST', body: '{}' }));
  expect(response.status).toBe(503);
  expect(state.invalidations).toBeGreaterThanOrEqual(1);
  expect(state.upstream.filter(p => p === '/api/signup')).toHaveLength(1);
});

it('passes a real 502 from a healthy Pocket ID straight through', async () => {
  vi.mocked(fetch).mockImplementation(async (url: string | URL | Request) => {
    const path = new URL(url instanceof Request ? url.url : String(url)).pathname;
    state.upstream.push(path);
    return path === '/healthz' ? new Response(null, { status: 204 }) : new Response('upstream says 502', { status: 502 });
  });
  const response = await route.GET(new Request('https://idp.test/login'));
  expect(response.status).toBe(502);
  expect(state.invalidations).toBe(0);
});
