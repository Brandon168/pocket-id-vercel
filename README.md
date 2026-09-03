# Pocket ID on Vercel — workshop sidecar template

Passkey-only OIDC provider ([Pocket ID](https://github.com/pocket-id/pocket-id), Go + embedded SvelteKit SPA)
running as a Vercel Container Images function with Neon Postgres. Zero code changes to upstream.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FBrandon168%2Fpocket-id-vercel&project-name=idp-ws-DATE-TOPIC&env=PORT%2CDISABLE_RATE_LIMITING&envDefaults=%7B%22PORT%22%3A%221411%22%2C%22DISABLE_RATE_LIMITING%22%3A%22true%22%7D&envDescription=PORT%20must%20be%201411%20(the%20container%20listens%20there)%3B%20rate%20limiting%20is%20off%20because%20conference%20NAT%20shares%20one%20IP.&envLink=https%3A%2F%2Fgithub.com%2FBrandon168%2Fpocket-id-vercel%23env-vars&stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22neon%22%2C%22productSlug%22%3A%22neon%22%2C%22protocol%22%3A%22storage%22%7D%5D)

## Click path (instructor, ~15 min)

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

## During the workshop

- **One thing at a time.** Pocket ID is single-replica (embedded actor host, max 1 host per
  database): overlapping requests can start a second function instance that crash-loops with
  `already one instance running`, and routed requests 500 for ~5 min. Serial traffic with ≥5 s
  gaps is fine; bursts (QR-scan stampedes included) are not — stagger registration.
- **Never deploy during the session.** A production deploy 500s until the old holder scales in.
- If `/login` 500s: stop all traffic, wait 5 min idle, retry once. Still 500 → check
  `vercel logs` for `already one instance running` (contention — keep waiting) vs a real app error.

## Teardown (same day)

Marketplace resources do **not** die with the project — delete both, or the Neon DB (attendee PII) survives:

```bash
./teardown.sh idp-ws-2026-09-12-oidc --scope <team> --yes
```

Then verify in the dashboard: project gone **and** Neon resource gone.

## Env vars

| Var | Value | Notes |
|---|---|---|
| `PORT` | `1411` | Container router target. Pre-filled by the Deploy Button. |
| `DISABLE_RATE_LIMITING` | `true` | Conference NAT shares one IP. Pre-filled. Unset for a shared/long-lived instance. |
| `ENCRYPTION_KEY` | `openssl rand -base64 32` | **You provide it at deploy time.** ≥16 bytes or the container exits. Password manager. |
| `STATIC_API_KEY` | `openssl rand -hex 32` | **You provide it at deploy time.** ≥16 chars. Drives `setup.sh`. |
| `APP_URL` | optional | Only for a custom domain. Set **before** the first passkey (WebAuthn RP ID = hostname). |
| `DATABASE_URL_UNPOOLED` | Neon-injected | Do not set by hand. |
| `MAXMIND_LICENSE_KEY` | unset | If set, GeoLite (~60 MB) downloads to `/tmp` on every cold start. |

Project settings (set in dashboard after deploy): single region co-located with Neon (`iad1`),
Performance CPU, Deployment Protection **off** for production, Vercel Toolbar **off** (breaks the
nonce CSP), no WAF/Attack Challenge (breaks `/api/oidc/token`).

## Files

- `Dockerfile.vercel` — upstream Pocket ID image, runs as UID 1000, maps
  `DATABASE_URL_UNPOOLED`→`DB_CONNECTION_STRING` and derives `APP_URL` at boot.
- `vercel.json` — production-only builds (`ignoreCommand`), single region `iad1`, two daily
  `/healthz` wake-to-work crons for the midnight cron actors.
- `setup.sh` — idempotent provisioner (admin + login link, config, group + client, signup token).
- `teardown.sh` — deletes project **and** Neon resource.

## How it works

- Pocket ID keeps its own users, passkeys, and sessions in Postgres via `DATABASE_URL_UNPOOLED`.
  No object storage, no filesystem, no external auth service.
- Uploads (avatars, logos) live in Postgres (`FILE_BACKEND=database`).
- The container derives its canonical URL from the deployment, so WebAuthn RP IDs match with no
  manual `APP_URL` unless you add a custom domain later.
