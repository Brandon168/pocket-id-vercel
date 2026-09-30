import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

// Sandbox start path against disposable Postgres and a fake Sandbox. No Vercel calls.
const state = vi.hoisted(() => ({
  db: null as PGlite | null,
  running: '0',
  commands: [] as string[],
  events: [] as string[],
}));
vi.mock('@neondatabase/serverless', () => ({
  neon: () => async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.reduce((sql, part, index) => sql + (index ? `$${index}` : '') + part, '');
    if (query.includes('francis_hosts')) state.events.push('delete-host-row');
    return (await state.db!.query(query, values)).rows;
  },
}));
vi.mock('@vercel/sandbox', () => {
  const sandbox = {
    status: 'running',
    expiresAt: new Date(Date.now() + 10 * 60 * 60_000),
    domain: () => 'https://sb-test.vercel.run',
    writeFiles: async () => undefined,
    extendTimeout: async () => undefined,
    runCommand: async (command: string | { args: string[] }, args?: string[]) => {
      const line = typeof command === 'string' ? `${command} ${(args ?? []).join(' ')}` : command.args.join(' ');
      state.commands.push(line);
      if (line.includes('pgrep')) return { stdout: async () => `${state.running}\n`, exitCode: 0 };
      if (line.includes('exec')) state.events.push('start-process');
      return { stdout: async () => '', stderr: async () => '', exitCode: 0 };
    },
  };
  return { Sandbox: { getOrCreate: async () => sandbox, get: async () => sandbox } };
});

let control: typeof import('../lib/sandbox-control');

beforeAll(async () => {
  vi.stubEnv('CONTROLLER_DATABASE_URL', 'postgresql://unused@localhost/controller');
  vi.stubEnv('DATABASE_URL_UNPOOLED', 'postgresql://unused@localhost/pocket');
  vi.stubEnv('ENCRYPTION_KEY', 'local-test-encryption');
  vi.stubEnv('STATIC_API_KEY', 'local-test-api');
  vi.stubEnv('WORKSHOP_ADMIN_SECRET', 'local-test-instructor');
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
});

beforeEach(async () => {
  await state.db?.close();
  state.db = new PGlite();
  state.commands = []; state.events = [];
  vi.resetModules();
  control = await import('../lib/sandbox-control');
});

afterAll(async () => { await state.db?.close(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

async function hostRows() {
  return (await state.db!.query('SELECT host_address FROM francis_hosts')).rows;
}

it('clears a stale actor-host row before starting Pocket ID after an unclean stop', async () => {
  await state.db!.exec(`CREATE TABLE francis_hosts (host_address text); INSERT INTO francis_hosts VALUES ('127.0.0.1:1414'), ('10.0.0.9:1414')`);
  state.running = '0';
  expect(await control.ensureSandboxReady()).toBe('https://sb-test.vercel.run');
  expect(state.events).toEqual(['delete-host-row', 'start-process']);
  // Only the Sandbox's own loopback address is removed.
  expect(await hostRows()).toEqual([{ host_address: '10.0.0.9:1414' }]);
});

it('leaves the host row alone when Pocket ID is already running', async () => {
  await state.db!.exec(`CREATE TABLE francis_hosts (host_address text); INSERT INTO francis_hosts VALUES ('127.0.0.1:1414')`);
  state.running = '1';
  await control.ensureSandboxReady();
  expect(state.events).toEqual([]);
  expect(await hostRows()).toHaveLength(1);
});

it('starts on a first boot, before Pocket ID has created its tables', async () => {
  state.running = '0';
  await control.ensureSandboxReady();
  expect(state.events).toEqual(['delete-host-row', 'start-process']);
});

it('serves a self-refreshing page to browsers and JSON to API callers during a cold start', async () => {
  const { isPageNavigation, startingPage } = await import('../lib/starting-page');
  expect(isPageNavigation(new Request('https://idp.test/signup', { headers: { 'sec-fetch-mode': 'navigate' } }))).toBe(true);
  expect(isPageNavigation(new Request('https://idp.test/api/signup', { headers: { 'sec-fetch-mode': 'cors', accept: 'text/html' } }))).toBe(false);
  expect(isPageNavigation(new Request('https://idp.test/', { headers: { accept: 'text/html,*/*' } }))).toBe(true);
  expect(isPageNavigation(new Request('https://idp.test/api/signup', { method: 'POST', headers: { 'sec-fetch-mode': 'navigate' } }))).toBe(false);
  expect(isPageNavigation(new Request('https://idp.test/.well-known/openid-configuration'))).toBe(false);
  expect(startingPage).toContain('http-equiv="refresh"');
});
