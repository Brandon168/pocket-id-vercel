# Pocket ID on Vercel — workshop sidecar template

Passkey-only OIDC provider ([Pocket ID](https://github.com/pocket-id/pocket-id), Go + embedded SvelteKit SPA).
Zero code changes to upstream.

**Default for workshops: run it as a single-process [Vercel Sandbox](https://vercel.com/docs/sandbox)
microVM** (`sandbox-up.mjs`), not as a Fluid Function. Pocket ID embeds a single-replica actor
host (max 1 host per database): on Functions, any 2 overlapping requests start a second instance
that crash-loops and 500s. A Sandbox runs exactly one `pocket-id` process — measured **300
concurrent VUs, zero 5xx, p95 ~205 ms** (4 vCPU). The Function path (`Dockerfile.vercel`) is kept
for small/low-concurrency use; see "Function path" below.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FBrandon168%2Fpocket-id-vercel&project-name=idp-ws-DATE-TOPIC&env=PORT%2CDISABLE_RATE_LIMITING&envDefaults=%7B%22PORT%22%3A%221411%22%2C%22DISABLE_RATE_LIMITING%22%3A%22true%22%7D&envDescription=PORT%20must%20be%201411%20(the%20container%20listens%20there)%3B%20rate%20limiting%20is%20off%20because%20conference%20NAT%20shares%20one%20IP.&envLink=https%3A%2F%2Fgithub.com%2FBrandon168%2Fpocket-id-vercel%23env-vars&stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22neon%22%2C%22productSlug%22%3A%22neon%22%2C%22protocol%22%3A%22storage%22%7D%5D)

## Click path — Sandbox (recommended, ~20 min, handles 300 concurrent)

Prereqs: Node 22+, `npm i @vercel/sandbox`, `vercel` CLI logged in, and a **fresh**
Postgres database (new Neon DB/branch — never reuse one whose keys were encrypted with a
different `ENCRYPTION_KEY`, or boot fails decrypting the JWT key).

1. **Boot the sandbox** (4 vCPU held 300 VUs at p95 ~205 ms; 8 h default session, Pro max 24 h):
   ```bash
   DB_CONNECTION_STRING='postgresql://…' \
   ENCRYPTION_KEY="$(openssl rand -base64 32)" \
   STATIC_API_KEY="$(openssl rand -hex 32)" \
   node sandbox-up.mjs --name idp-ws-2026-09-12-oidc --vcpus 4 --timeout 8h
   ```
   Save the printed `APP_URL` (stable for the sandbox's life, across stop/resume — but a
   *new* sandbox gets a *new* URL, and passkeys bind to the hostname, so keep the name).
   Save both keys in a password manager now — they are unrecoverable.
2. **Provision the workshop** (same `setup.sh` as the Function path):
   ```bash
   APP_URL=https://<sandbox-domain> \
   STATIC_API_KEY=<the key from step 1> \
   ./setup.sh --headcount 300 --tokens 4 --days 2
   ```
   Pocket ID caps one signup token at 100 uses: `--tokens 4` mints 4 parallel links
   (400 uses). QR **all** of them — one per table, or rotate the slides — so the rush
   spreads across token counters. Prints the instructor Login Code link too (valid ~15 min).
3. **Before the session**, open the URL once. No 5-min idle dance: the process is already running.
   Register your instructor passkey (`/settings/account` → Add passkey) **before** attendees arrive —
   `APP_URL` must be final first (WebAuthn RP ID = hostname).

## Click path — Function (small groups only, ≤ ~10 concurrent)

One-click Deploy Button + Neon `stores` integration, same as before. Fine for demos and small
rooms. **Do not use for 50+ simultaneous registrations**: any overlap 500s (see "Why Sandbox").
Steps are identical to the Sandbox path after deploy, with `APP_URL=https://<project>.vercel.app`:
1. **Click Deploy.** Name the project `idp-ws-<date>-<topic>` (e.g. `idp-ws-2026-09-12-oidc`).
   When prompted for env vars, fill in:
   - `ENCRYPTION_KEY` — generate locally: `openssl rand -base64 32`. **Stable per instance,
     unrecoverable if lost.** Save it in a password manager now.
   - `STATIC_API_KEY` — any random string ≥16 chars: `openssl rand -hex 32`. Save it too.
   - `PORT` (default `1411`) and `DISABLE_RATE_LIMITING` (default `true`) are pre-filled — leave them.
   - You will also be asked to create a **Neon Postgres** database (via the `stores` integration).
     When Neon shows an **Auth** toggle during setup, turn it **off** — Pocket ID is itself the
     auth system and never uses Neon's Managed Better Auth tables.
2. **Wait for the first production deployment to go Ready**, then idle ~5 min (the embedded actor
   host needs a quiet window to elect itself on first boot).
3. **Provision the workshop** (needs `curl`, `python3` — clone this repo or download `setup.sh`):
   ```bash
   APP_URL=https://idp-ws-2026-09-12-oidc.vercel.app \
   STATIC_API_KEY=<the key from step 1> \
   ./setup.sh --headcount 60 --days 2
   ```
   This creates the instructor admin, prints a one-time **Login Code link** (valid ~15 min —
   open it in the browser that will hold your passkey, then `/settings/account` → Add passkey),
   locks signups to token-only, creates group `workshop` + public PKCE client `workshop-app`
   (callback `https://*.vercel.app/api/auth/callback/pocket-id`, restricted to `workshop`),
   and prints the **attendee signup link** — QR this.
4. **Five minutes before the session**, open the URL once (cold start is the first participant's
   problem otherwise — ~7 s in-container boot, ~2.6 s cold `/login` after 5-min idle).

## During the workshop (Sandbox)

- **No stagger needed.** One process serves everyone: measured 300 concurrent VUs, zero 5xx,
  p50 ~119 ms / p95 ~204 ms / max 1.3 s on 4 vCPU. All responses under the 3 s budget.
- **Never stop/remove the sandbox mid-session** — the process holds everything; resume is fast
  but drops in-flight requests. Session timeout counts from boot: `vercel sandbox list` shows
  expiry; extend with the SDK (`sandbox.extendTimeout`) or stop/resume before it lapses.
- If the page ever fails: check the process is alive (`sandbox exec <name> -- ps aux | grep pocket-id`);
  if dead, re-run the detached start (same `/tmp/pocket-env.sh`) — the DB holds all state.

## During the workshop (Function path — small groups)

- **One thing at a time.** Overlapping requests start a second instance that crash-loops with
  `already one instance running`, and routed requests 500 for ~5 min. Serial traffic with ≥1 s
  gaps is fine; bursts (QR-scan stampedes included) are not — stagger registration.
- **Never deploy during the session.** A production deploy 500s until the old holder scales in.
- If `/login` 500s: stop all traffic, wait 5 min idle, retry once. Still 500 → check
  `vercel logs` for `already one instance running` (contention — keep waiting) vs a real app error.

## Why Sandbox (measurements, 2026-09-03)

| Test | Result |
|---|---|
| Function, serial ≥1 s gaps | 100% clean (18/18 + 6/6) |
| Function, 0.5 s gaps | alternating 204/500 — every other request hits a newcomer |
| Function, 2 VUs | 30–40% failed (`ErrClusterFull` crash-loops) |
| Function, ramp 1→25 VUs, 3,383 reqs | 84% ok / 16% 500, 30 crash-loops, full recovery after ~5–8 min idle |
| Sandbox, reads 1→300 VUs, 271,336 reqs | **100% ok, 0 failed**, p50 119 ms / p95 206 ms / max 1.5 s |
| Sandbox, registrations 300 VUs vs 4× limit-100 tokens | **all 400 token uses consumed, zero 5xx**, every check under 3 s |
| Sandbox, fork from golden snapshot | boots UP in ≤5 s, identical behavior (400/400 consumed, zero 5xx) |

Pocket ID caps one signup token at 100 uses (`signupTokenCreateDto` binding max). For 300
attendees, `setup.sh --tokens 4` (default) mints 4 parallel links. Failure mode seen in testing:
~1,300 req/s against an exhausted token returns clean 401s (`token_invalid_or_expired`) — no 5xx,
no state damage. Keep one spare token un-QR'd for latecomers.

## Teardown (same day)

Sandbox path — delete the sandbox **and** drop the workshop database (attendee PII lives in both
the DB and the sandbox's filesystem snapshot):

```bash
node sandbox-down.mjs --name idp-ws-2026-09-12-oidc
# then drop the Neon branch/DB, e.g. in the Neon dashboard or:
# psql $ADMIN_URL -c "DROP DATABASE <workshop-db>;"
```

Function path — Marketplace resources do **not** die with the project:

```bash
./teardown.sh idp-ws-2026-09-12-oidc --scope <team> --yes
```

Then verify in the dashboard: project gone **and** Neon resource gone.

## Env vars

| Var | Value | Notes |
|---|---|---|
| `PORT` | `1411` | Container/sandbox listen port. Pre-filled by the Deploy Button. |
| `DISABLE_RATE_LIMITING` | `true` | Conference NAT shares one IP. Pre-filled. Unset for a shared/long-lived instance. |
| `ENCRYPTION_KEY` | `openssl rand -base64 32` | **You provide it.** ≥16 bytes or the process exits. Stable per DB — a fresh DB needs a fresh key; reusing a DB with the wrong key fails decrypting the JWT key. Password manager. |
| `STATIC_API_KEY` | `openssl rand -hex 32` | **You provide it.** ≥16 chars. Drives `setup.sh`. |
| `APP_URL` | sandbox URL / custom domain | Must equal the public origin **before** the first passkey (WebAuthn RP ID = hostname). `sandbox-up.mjs` sets it from the sandbox domain automatically. |
| `DATABASE_URL_UNPOOLED` | Neon-injected (Function) / you provide (Sandbox) | Sandbox: any unpooled Postgres URL (Neon branch). Do not share one DB between two running instances — second holder crash-loops. |
| `MAXMIND_LICENSE_KEY` | unset | If set, GeoLite (~60 MB) downloads to `/tmp` on every cold start. |

Project settings (Function path, dashboard after deploy): single region co-located with Neon
(`iad1`), Performance CPU, Deployment Protection **off** for production, Vercel Toolbar **off**
(breaks the nonce CSP), no WAF/Attack Challenge (breaks `/api/oidc/token`).

## Files

- `Dockerfile.vercel` — upstream Pocket ID image, runs as UID 1000, maps
  `DATABASE_URL_UNPOOLED`→`DB_CONNECTION_STRING` and derives `APP_URL` at boot (Function path).
- `vercel.json` — production-only builds (`ignoreCommand`), single region `iad1`, two daily
  `/healthz` wake-to-work crons for the midnight cron actors (Function path).
- `setup.sh` — idempotent provisioner (admin + login link, config, group + client, `--tokens N`
  parallel signup links). Works against either path — just point `APP_URL` at it.
- `sandbox-up.mjs` / `sandbox-down.mjs` — boot/teardown the Sandbox path (Node 22+, `@vercel/sandbox`).
- `teardown.sh` — deletes a Function-path project **and** its Neon resource.

## How it works

- Pocket ID keeps its own users, passkeys, and sessions in Postgres via the unpooled URL.
  No object storage, no filesystem, no external auth service.
- Uploads (avatars, logos) live in Postgres (`FILE_BACKEND=database`).
- Sandbox path: one microVM → one `pocket-id` process → one DB. No second holder can exist, so
  the single-replica constraint is satisfied structurally. Needs Node + `@vercel/sandbox`
  (v3.2.1 tested) and a VCR `dockerfile` image (built automatically by any git deploy).
- Function path: the container derives its canonical URL from the deployment, so WebAuthn RP IDs
  match with no manual `APP_URL` unless you add a custom domain later.
