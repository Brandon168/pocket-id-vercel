// NOTE: this file uses ESM `import`. Run with node >= 22 and either
// `"type": "module"` in package.json or as `node --input-type=module`.
// Simplest: npm i @vercel/sandbox && node sandbox-up.mjs …
import { Sandbox } from '@vercel/sandbox';

// sandbox-up.mjs — bootstrap the one persistent Sandbox the Vercel controller manages.
//
// Usage (env required):
//   DB_CONNECTION_STRING='postgresql://…' \
//   ENCRYPTION_KEY='…' STATIC_API_KEY='…' \
//   APP_URL='https://stable-controller.vercel.app' \
//   node sandbox-up.mjs [--name N] [--vcpus 4] [--timeout 5m] [--image TAG]
//
// The sandbox route is an internal origin only. APP_URL remains the stable
// controller hostname across every stop/resume, which preserves OIDC issuer and
// WebAuthn RP ID. The controller extends sessions while active and idle-stops them.
const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const NAME = opt('--name', `pocket-ws-${new Date().toISOString().slice(0, 10)}`);
const VCPUS = Number(opt('--vcpus', '4'));
const TIMEOUT = opt('--timeout', '5m');
let IMAGE = opt('--image', '');
const toMs = (s) => {
  const m = s.match(/^(\d+)(m|h|d)$/);
  if (!m) throw new Error(`bad --timeout ${s} (e.g. 8h, 24h, 30m)`);
  return Number(m[1]) * ({ m: 6e4, h: 3.6e6, d: 8.64e7 }[m[2]]);
};

const env = {
  DB_CONNECTION_STRING: process.env.DB_CONNECTION_STRING,
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
  STATIC_API_KEY: process.env.STATIC_API_KEY,
  APP_URL: process.env.APP_URL,
};
for (const [k, v] of Object.entries(env)) {
  if (!v) {
    console.error(`missing env ${k}`);
    process.exit(2);
  }
}
Object.assign(env, {
  APP_ENV: 'production',
  PORT: '1411',
  ACTORS_HOST: '127.0.0.1',
  FILE_BACKEND: 'database',
  GEOLITE_DB_PATH: '/tmp/GeoLite2-City.mmdb',
  TRUSTED_PLATFORM: 'X-Real-IP',
  ALLOW_INSECURE_CALLBACK_URLS: 'false',
  ANALYTICS_DISABLED: 'true',
  VERSION_CHECK_DISABLED: 'true',
  LOG_JSON: 'true',
  DISABLE_RATE_LIMITING: 'true',
  APP_URL: env.APP_URL,
});

const sbx = await Sandbox.create({
  name: NAME,
  ...(IMAGE ? { image: IMAGE } : {}),
  ports: [1411],
  timeout: toMs(TIMEOUT),
  resources: { vcpus: VCPUS },
  tags: { purpose: 'pocket-id-workshop' },
});
const sandboxOrigin = 'https://' + new URL(sbx.domain(1411)).host;
console.log('sandbox:', sbx.name, sbx.status, sbx.region);
console.log('internal sandbox origin:', sandboxOrigin);
console.log('canonical APP_URL:', env.APP_URL);

const exportStr = Object.entries(env)
  .map(([k, v]) => `export ${k}='${v.replace(/'/g, "'\\''")}'`)
  .join('\n');
await sbx.writeFiles([{ path: '/tmp/pocket-env.sh', content: new TextEncoder().encode(exportStr + '\n'), mode: 0o600 }]);
const cmd = await sbx.runCommand({
  cmd: 'sh',
  args: ['-lc', '. /tmp/pocket-env.sh && exec /app/pocket-id'],
  detached: true,
});
console.log('pocket-id detached:', cmd.cmdId);

// Poll 127.0.0.1:1411/healthz inside the sandbox until UP (fresh DB migrates).
for (let i = 0; i < 24; i++) {
  const { promise, resolve } = Promise.withResolvers();
  setTimeout(resolve, 1000);
  await promise;
  const probe = await sbx.runCommand('sh', [
    '-lc',
    'wget -q -O/dev/null --timeout=4 http://127.0.0.1:1411/healthz && echo UP || echo DOWN',
  ]);
  const state = (await probe.stdout()).trim();
  console.log(`t+${i + 1}s: ${state}`);
  if (state === 'UP') break;
}
console.log('');
console.log('Next:');
console.log(`  APP_URL=${env.APP_URL} STATIC_API_KEY='<same key>' ./setup.sh --headcount 300 --tokens 4`);
console.log(`Controller will now own stop/resume for ${NAME}.`);
process.exit(0);
