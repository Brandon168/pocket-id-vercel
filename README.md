# Pocket ID on Vercel — workshop identity provider

A disposable passkey-only OIDC provider for a workshop. Deploy it, hand attendees one QR code, delete it afterwards. Runs upstream [Pocket ID](https://github.com/pocket-id/pocket-id) unmodified inside a single Vercel Sandbox, fronted by a small Next.js controller.

## Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FBrandon168%2Fpocket-id-vercel&project-name=idp-ws-DATE-TOPIC&repository-name=idp-ws-DATE-TOPIC&stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22neon%22%2C%22productSlug%22%3A%22neon%22%2C%22protocol%22%3A%22storage%22%7D%5D)

1. **Click Deploy.** Name the project, create the Neon store when asked, and uncheck the Neon Auth option (not used). Nothing else to fill in.
2. **The moment it says Ready, open `https://<project>.vercel.app`.** Use the short production domain, not the longer `<project>-xxxx-<team>.vercel.app` deployment URL. Every path on the new project redirects to a one-time `/setup` screen. Until someone completes it, the first visitor owns the workshop, so do this right away.
3. **On `/setup`, pick the room size and whether attendees must give an email, then click once.** It generates the workshop's secrets and shows you an instructor password one time. Save it.
4. **Continue to `/workshop`.** At the browser sign-in prompt, leave the username empty and paste the password.
5. **Click Prepare workshop.** The first run starts Pocket ID (about a minute), then creates the instructor admin, workshop group, OIDC client, and signup capacity.
6. **Put the QR code on your slide.** Open the one-time admin login in your own browser and add a passkey under Settings → Account. Pocket ID's admin tools (Users, User Groups, OIDC Clients, Application Configuration) appear as an **Administration** section in the Settings sidebar once you are signed in as `instructor`, or directly at `/settings/admin/users`.

Pro or Enterprise is required: the idle cron runs every minute and Sandbox sessions exceed Hobby limits.

### Why the production domain matters

The controller uses `https://<project>.vercel.app` as Pocket ID's `APP_URL`, OIDC issuer, and WebAuthn relying-party ID. Passkeys registered on any other hostname will not work. Standard Deployment Protection leaves this domain public while protecting deployment URLs, which is what you want; do not switch protection to "All Deployments".

## What `/setup` generates

| Secret | Purpose | Visibility |
|---|---|---|
| Encryption key | Protects Pocket ID's stored private keys | Never shown |
| Pocket ID API key | Server-side provisioning from the console | Behind a disclosure on `/setup`; only needed for `setup.sh` |
| Instructor password | Basic-auth password for `/workshop`; stored as a hash | Shown once on `/setup` |

All three live in the workshop's Neon database next to the data they protect. For a workshop that exists for a few days and is then deleted, that is the intended trade for a zero-input deploy. The claim is atomic, so exactly one visitor can complete setup; afterwards `/setup` redirects to `/workshop` permanently. If `/setup` says someone else already completed it, delete the project and the Neon resource and deploy again.

Lost the password? Set `WORKSHOP_ADMIN_SECRET` on the Vercel project and redeploy. Environment variables override the generated values.

## Attendee signup

Pocket ID always requires a username and treats first and last name as optional; only email has a requirement toggle, which `/setup` exposes. After registering a passkey, attendees land on Pocket ID's `/settings/account` page. That destination is hard-coded in Pocket ID's frontend and cannot be changed from the controller.

Signup capacity is `expected attendees × 1.2`, rounded up to whole 100-use signup tokens (Pocket ID's per-token cap). `/join` rotates attendees across them. Tokens expire after 72 hours. The console shows live signup counts while Pocket ID is running.

### Attendees who cannot use a passkey

Passkeys need no app: Touch ID, Face ID, Windows Hello, or Android screen lock all work, and the browser offers a QR code so a personal phone can hold the passkey for a locked-down laptop. For the few who are blocked entirely:

- **Skip for now** at the passkey step. Signup already signed them in, and the controller sets Pocket ID sessions to 30 days, so they stay signed in for the whole event on that device.
- **Signed out or on another device:** in `/workshop`, type their username under *Help an attendee* and send them the one-time login link. This is Pocket ID's login-code feature, also available in the admin UI under Users.

## Teardown

Delete both the Vercel project (which removes the Sandbox and snapshots) and the Neon Marketplace resource (which holds attendee identities and controller state). Marketplace resources survive project deletion; `teardown.sh` removes both.

## How it works

![Architecture: a Next.js controller proxies OIDC traffic to one Vercel Sandbox running Pocket ID, with Neon storing identity and lifecycle state.](assets/pocket-id-vercel-architecture.jpg)

Pocket ID embeds a single-host actor system, so exactly one process may run per database. The controller enforces that:

- **One Sandbox, one process.** A named persistent Sandbox runs Pocket ID v2.14.0 (downloaded and SHA-256-verified on first boot). The controller proxies every request to it and rewrites redirects back to the stable hostname.
- **Neon-backed lease.** Concurrent cold requests elect one starter through an expiring lease; the rest wait for the same origin. Fluid compute can run many controller invocations without starting a second Pocket ID.
- **Scale to zero.** A one-minute cron stops and snapshots the Sandbox after `SANDBOX_IDLE_MINUTES` (default 120) without traffic. The next request resumes it inside the same HTTP call. Graceful stop clears the stale actor-host row so restart is never blocked.
- **Shared database.** One Neon project holds Pocket ID's tables and the controller's lifecycle, workshop, and secrets tables. Set `CONTROLLER_DATABASE_URL` to split them.

> The controller and lifecycle were load-tested in an earlier iteration. The Deploy Button path with first-run setup is newer; run it end to end before relying on it for an event.

## Environment variables

None are required. The Neon store injects `DATABASE_URL` and `DATABASE_URL_UNPOOLED`. Optional overrides:

| Variable | Notes |
|---|---|
| `ENCRYPTION_KEY`, `STATIC_API_KEY`, `WORKSHOP_ADMIN_SECRET` | Override generated secrets. Setting all three skips `/setup` entirely. |
| `APP_URL` | Exact public origin, if not the production `.vercel.app` domain. |
| `SANDBOX_IDLE_MINUTES` | Default 120. |
| `SANDBOX_NAME`, `SANDBOX_IMAGE`, `SANDBOX_STARTUP_TIMEOUT_MS` | Sandbox tuning. |
| `WORKSHOP_SETUP_DELAY_MS` | Gap between provisioning calls. Default 1000. |
| `CONTROLLER_DATABASE_URL` | Separate database for controller tables. |
| `LIFECYCLE_ADMIN_SECRET` | Enables manual `POST /api/lifecycle/stop`. |
| `CRON_SECRET` | Vercel supplies this to cron calls. |

## Operations

```bash
curl https://<project>.vercel.app/api/lifecycle/status          # inspect without waking the Sandbox
curl -X POST https://<project>.vercel.app/api/lifecycle/stop \
  -H "Authorization: Bearer $LIFECYCLE_ADMIN_SECRET"             # manual graceful stop
```

A stopped Sandbox costs only snapshot storage. `setup.sh` remains for custom headcounts, durations, or client settings and needs the API key from `/setup`.

## Files

- `proxy.ts` — first-run gate and Basic-auth guard for `/workshop`.
- `app/setup`, `app/api/setup` — one-time secret generation and workshop options.
- `app/workshop`, `app/api/workshop` — instructor console, QR, admin handoff.
- `app/join/route.ts` — stable attendee URL rotated across signup tokens.
- `app/[[...path]]/route.ts` — reverse proxy to the Sandbox.
- `app/api/lifecycle/*` — cron, status, manual stop.
- `lib/secrets.ts` — Neon-backed secrets with atomic single-winner claim and env overrides.
- `lib/workshop{,-store,-auth}.ts` — provisioning, persistence, instructor access.
- `lib/sandbox-control.ts`, `lib/lifecycle-store.ts` — Sandbox state machine and lease.
- `image/Dockerfile`, `setup.sh`, `sandbox-up.mjs`, `sandbox-down.mjs`, `teardown.sh` — optional tooling.
