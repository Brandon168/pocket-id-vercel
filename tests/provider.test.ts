import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, createPublicKey, verify } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

const state = vi.hoisted(() => ({ db: null as PGlite | null, origin: 'http://localhost:14119' }));
vi.mock('@neondatabase/serverless', () => ({
  neon: () => async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.reduce((sql, part, index) => sql + (index ? `$${index}` : '') + part, '');
    return (await state.db!.query(query, values)).rows;
  },
}));
vi.mock('../lib/sandbox-control', () => ({ getKnownSandboxOrigin: async () => state.origin }));
vi.mock('../lib/lifecycle-store', () => ({ getLifecycleState: async () => ({ status: 'running' }) }));

// Opt-in, real Pocket ID v2.14.0 process. Controller SQL runs in PGlite;
// provider data is SQLite in a fresh temporary directory. No Vercel calls.
describe.skipIf(!process.env.POCKET_ID_TEST_BINARY)('real Pocket ID provider', () => {
  let directory: string;
  let provider: ChildProcess;
  let workshop: typeof import('../lib/workshop');
  let store: typeof import('../lib/workshop-store');
  let diagnostics = '';

  async function api(path: string) {
    const response = await fetch(`${state.origin}/api${path}`, { headers: { 'x-api-key': 'isolated-provider-test-key' } });
    expect(response.ok, `${path}: ${response.status}`).toBe(true);
    return response.json();
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'pocket-provider-test-'));
    state.db = new PGlite();
    vi.stubEnv('WORKSHOP_SETUP_DELAY_MS', '0');
    vi.stubEnv('CONTROLLER_DATABASE_URL', 'postgresql://unused:unused@localhost/isolated');
    vi.stubEnv('APP_URL', state.origin);
    vi.stubEnv('ENCRYPTION_KEY', '12345678901234567890123456789012');
    vi.stubEnv('STATIC_API_KEY', 'isolated-provider-test-key');
    vi.stubEnv('WORKSHOP_ADMIN_SECRET', 'isolated-instructor-test-key');
    provider = spawn(process.env.POCKET_ID_TEST_BINARY!, [], {
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'test',
        APP_URL: state.origin, HOST: '127.0.0.1', PORT: '14119', ACTORS_HOST: '127.0.0.1', ACTORS_PORT: '14120',
        DB_CONNECTION_STRING: join(directory, 'test.db'),
        ENCRYPTION_KEY: process.env.ENCRYPTION_KEY, STATIC_API_KEY: process.env.STATIC_API_KEY,
        ANALYTICS_DISABLED: 'true', VERSION_CHECK_DISABLED: 'true', DISABLE_RATE_LIMITING: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    provider.stdout?.on('data', data => { diagnostics += data; });
    provider.stderr?.on('data', data => { diagnostics += data; });
    provider.on('error', error => { diagnostics += error.message; });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (provider.exitCode !== null) throw new Error(`Provider exited: ${diagnostics.slice(-2000)}`);
      try { ready = (await fetch(`${state.origin}/.well-known/openid-configuration`)).ok; } catch { /* starting */ }
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error(`Provider did not start: ${diagnostics.slice(-2000)}`);
    workshop = await import('../lib/workshop');
    store = await import('../lib/workshop-store');
  });

  afterAll(async () => {
    if (provider && provider.exitCode === null) {
      const exited = once(provider, 'exit');
      provider.kill('SIGTERM');
      const forceStop = setTimeout(() => provider.kill('SIGKILL'), 5_000);
      await exited;
      clearTimeout(forceStop);
    }
    await state.db?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('prepares 1000 signups and a confidential, group-restricted Passport client', async () => {
    await store.saveWorkshopOptions(workshop.getWorkshopName(), workshop.parseWorkshopOptions({ mode: 'passport', expectedAttendees: 1000 }));
    const setup = await workshop.setupWorkshop(state.origin);
    expect(setup.capacity).toBe(1200);
    const client = await api('/oidc/clients/workshop-passport');
    expect(client).toMatchObject({ isPublic: false, pkceEnabled: true, isGroupRestricted: true, callbackURLs: ['https://connect.vercel.com/callback'] });
    expect(client.allowedUserGroups).toHaveLength(1);
    const tokens = await api('/signup-tokens?pagination[limit]=100');
    expect(tokens.data).toHaveLength(12);
    expect(tokens.data.every((token: { usageLimit: number; usageCount: number }) => token.usageLimit === 100 && token.usageCount === 0)).toBe(true);
    const listed = await api('/users?pagination[limit]=100');
    expect(listed.data.filter((user: { isAdmin: boolean }) => !user.isAdmin)).toHaveLength(0);
    const before = await store.getPassportConnection(workshop.getWorkshopName());
    expect(before?.clientSecret).toBeTruthy();
    await workshop.setupWorkshop(state.origin);
    expect(await store.getPassportConnection(workshop.getWorkshopName())).toEqual(before);
    await workshop.repairConfigurationOnce();
    expect((await api('/oidc/clients/workshop-passport')).allowedUserGroups).toHaveLength(1);
  });

  it('registers an attendee on demand and exchanges a real authorization code using the saved secret', async () => {
    const setup = await store.getWorkshopSetup(workshop.getWorkshopName());
    const signup = await fetch(`${state.origin}/api/signup`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'test-attendee', firstName: 'Test', token: setup!.signupTokens[0] }),
    });
    expect(signup.ok, `signup: ${signup.status}`).toBe(true);
    const attendee = await signup.json();
    const cookie = signup.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const discovery = await (await fetch(`${state.origin}/.well-known/openid-configuration`)).json();
    const verifier = randomBytes(32).toString('base64url');
    const params = new URLSearchParams({
      response_type: 'code', client_id: 'workshop-passport', redirect_uri: workshop.passportCallbackUrl,
      scope: 'openid profile', state: 'test-state-123456', nonce: 'test-nonce-123456',
      code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    });
    const authorize = await fetch(`${discovery.authorization_endpoint}?${params}`, { headers: { cookie }, redirect: 'manual' });
    const redirect = new URL(authorize.headers.get('location')!, state.origin);
    expect(redirect.origin + redirect.pathname).toBe(workshop.passportCallbackUrl);
    expect(redirect.searchParams.get('state')).toBe('test-state-123456');
    expect(redirect.searchParams.get('error')).toBeNull();
    const code = redirect.searchParams.get('code');
    expect(code).toBeTruthy();
    const connection = await store.getPassportConnection(workshop.getWorkshopName());
    const form = new URLSearchParams({ grant_type: 'authorization_code', code: code!, redirect_uri: workshop.passportCallbackUrl, code_verifier: verifier });
    const rejected = await fetch(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${connection!.clientId}:wrong-secret`).toString('base64')}` },
      body: form,
    });
    expect(rejected.status).toBe(401);
    const tokens = await fetch(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${connection!.clientId}:${connection!.clientSecret}`).toString('base64')}` },
      body: form,
    });
    expect(tokens.ok, `token exchange: ${tokens.status}`).toBe(true);
    const tokenBody = await tokens.json();
    const [headerPart, payloadPart, signature] = tokenBody.id_token.split('.');
    const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString());
    const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString());
    expect(payload).toMatchObject({ sub: attendee.id, iss: state.origin, nonce: 'test-nonce-123456' });
    expect([payload.aud].flat()).toEqual(['workshop-passport']);
    const jwks = await (await fetch(discovery.jwks_uri)).json();
    const jwk = jwks.keys.find((key: { kid: string }) => key.kid === header.kid);
    expect(header.alg).toBe('RS256');
    expect(verify('RSA-SHA256', Buffer.from(`${headerPart}.${payloadPart}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(signature, 'base64url'))).toBe(true);
    expect((await workshop.getSignupProgress()).used).toBe(1);
  });

  // Vercel team mode presents every email as verified, so an attendee who
  // could edit their own email could claim anyone's Vercel account.
  it('stops attendees changing their own email once Vercel team mode is applied', async () => {
    const name = workshop.getWorkshopName();
    const setup = await store.getWorkshopSetup(name);
    const signup = await fetch(`${state.origin}/api/signup`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'email-attendee', email: 'email-attendee@event.example.com', token: setup!.signupTokens[0] }),
    });
    expect(signup.ok, `signup: ${signup.status}`).toBe(true);
    const cookie = signup.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const changeOwnEmail = () => fetch(`${state.origin}/api/users/me`, {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ username: 'email-attendee', email: 'someone-else@vercel.com' }),
    });
    const me = async () => (await (await fetch(`${state.origin}/api/users/me`, { headers: { cookie } })).json()).email;

    // Pocket ID's default: self-service edits are allowed (the hole).
    await changeOwnEmail();
    expect(await me()).toBe('someone-else@vercel.com');

    // Switching the prepared workshop to team mode and repairing it applies the lock.
    await store.saveWorkshopOptions(name, workshop.parseWorkshopOptions({ mode: 'vercel-team', emailDomain: 'event.example.com' }));
    await store.saveVercelConnection(name, { clientId: 'vercel-sso', clientSecret: 'unused', callbackUrl: workshop.defaultVercelCallbackUrl, teamSlug: null, scimProviderId: null, scimEndpoint: null });
    await api(`/users?search=email-attendee`).then(async ({ data }) => {
      const admin = await fetch(`${state.origin}/api/users/${data[0].id}`, {
        method: 'PUT', headers: { 'content-type': 'application/json', 'x-api-key': 'isolated-provider-test-key' },
        body: JSON.stringify({ username: 'email-attendee', email: 'email-attendee@event.example.com', emailVerified: true }),
      });
      expect(admin.ok, `admin reset: ${admin.status}`).toBe(true);
    });
    // A fresh module instance, as after a redeploy: repair runs once per process.
    vi.resetModules();
    const redeployed = await import('../lib/workshop');
    await redeployed.repairConfigurationOnce();
    const config = await api('/application-configuration/all');
    expect(config.find((entry: { key: string }) => entry.key === 'allowOwnAccountEdit')?.value).toBe('false');

    await changeOwnEmail();
    expect(await me()).toBe('email-attendee@event.example.com');
  });
});
