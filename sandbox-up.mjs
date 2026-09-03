// NOTE: this file uses ESM `import`. Run with node >= 22 and either
// `"type": "module"` in package.json or as `node --input-type=module`.
// Simplest: npm i @vercel/sandbox && node sandbox-up.mjs …
import { Sandbox } from '@vercel/sandbox';

// sandbox-up.mjs — boot a Pocket ID sidecar as a single-process Vercel Sandbox.
//
// Why: Pocket ID embeds a single-replica actor host (max 1 host per DB). On
// Fluid Functions any overlap starts a 2nd instance that crash-loops (500s).
// A Sandbox is ONE microVM running ONE pocket-id: measured 300 concurrent VUs,
// zero 5xx, p95 ~205 ms. Recommended for workshops of 50+ attendees.
//
// Usage (env required):
//   DB_CONNECTION_STRING='postgresql://…' \   # fresh DB! never reuse one
//   ENCRYPTION_KEY='…' \                       # encrypted with another key
//   STATIC_API_KEY='…' \
//   APP_SEED_URL='https://placeholder' \       # replaced with real domain after boot
//   node sandbox-up.mjs [--name N] [--vcpus N] [--timeout 8h] [--image TAG]
//
// After boot the script prints the public URL. Then:
//   APP_URL=<url> STATIC_API_KEY=<same key> ./setup.sh --headcount 300 --tokens 4
// APP_URL must equal the sandbox URL (WebAuthn RP ID = hostname).
const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const NAME = opt('--name', `pocket-ws-${new Date().toISOString().slice(0, 10)}`);
const VCPUS = Number(opt('--vcpus', '4'));
const TIMEOUT = opt('--timeout', '8h');
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
  APP_URL: 'https://placeholder.invalid', // replaced once the domain is known
});

const sbx = await Sandbox.create({
  name: NAME,
  ...(IMAGE ? { image: IMAGE } : {}),
  ports: [1411],
  timeout: toMs(TIMEOUT),
  resources: { vcpus: VCPUS },
  tags: { purpose: 'pocket-id-workshop' },
});
const appUrl = 'https://' + new URL(sbx.domain(1411)).host;
console.log('sandbox:', sbx.name, sbx.status, sbx.region);
console.log('APP_URL:', appUrl);
env.APP_URL = appUrl;

const exportStr = Object.entries(env)
  .map(([k, v]) => `export ${k}='${v.replace(/'/g, "'\\''")}'`)
  .join('\n');
await sbx.writeFiles([{ path: '/tmp/pocket-env.sh', content: Buffer.from(exportStr + '\n') }]);
const cmd = await sbx.runCommand({
  cmd: 'sh',
  args: ['-lc', '. /tmp/pocket-env.sh && exec /app/pocket-id'],
  detached: true,
});
console.log('pocket-id detached:', cmd.cmdId);

// Poll 127.0.0.1:1411/healthz inside the sandbox until UP (fresh DB migrates).
for (let i = 0; i < 24; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const probe = await sbx.runCommand('sh', [
    '-lc',
    'wget -q -O/dev/null --timeout=4 http://127.0.0.1:1411/healthz && echo UP || echo DOWN',
  ]);
  const state = (await probe.stdout()).trim();
  console.log(`t+${(i + 1) * 5}s: ${state}`);
  if (state === 'UP') break;
}
console.log('');
console.log('Next:');
console.log(`  APP_URL=${appUrl} STATIC_API_KEY='<same key>' ./setup.sh --headcount 300 --tokens 4`);
console.log(`Teardown: vercel sandbox remove ${NAME} (+ drop the database)`);
process.exit(0);
