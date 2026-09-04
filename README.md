# Pocket ID on Vercel — workshop sidecar

Run the upstream [Pocket ID](https://github.com/pocket-id/pocket-id) passkey-only OIDC provider on Vercel without changing its Go backend or embedded SvelteKit frontend. A thin Next.js controller gives browsers and relying-party apps one stable origin while a single persistent Vercel Sandbox satisfies Pocket ID's single-replica constraint.

This is a workshop sidecar: provision it for an event, let it idle to zero, then remove the Sandbox, identity database, and controller state.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FBrandon168%2Fpocket-id-vercel&project-name=idp-ws-DATE-TOPIC&repository-name=idp-ws-DATE-TOPIC&stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22neon%22%2C%22productSlug%22%3A%22neon%22%2C%22protocol%22%3A%22storage%22%7D%5D)

> **As soon as the deployment is Ready, open it.** The first visit to any URL on the new project lands on a one-time `/setup` screen that generates the workshop's secrets and shows you the instructor password once. There are no environment variables to type. Until setup runs, the first person to open the URL owns the workshop, so do it right after deploying.

## Architecture

![Pocket ID on Vercel architecture: a stable Next.js controller proxies OIDC traffic to one Vercel Sandbox, with Neon storing identity and lifecycle state.](assets/pocket-id-vercel-architecture.jpg)

> **Validation status:** The controller architecture was load-tested before the Deploy Button flow was added. The current template changes first boot, database layout, and workshop provisioning, so the earlier timing and throughput numbers do not describe this exact path. Run the wizard end to end before using it for a workshop.

The wake-up path resumes one named Vercel Sandbox. On its first start, the controller downloads the pinned Pocket ID v2.14.0 Linux binary and verifies its SHA-256 checksum. Later starts restore the persistent Sandbox filesystem. Every controller invocation coordinates through a Neon-backed lease before starting Pocket ID.

### Request path

1. Users and OIDC relying-party apps connect only to the controller's stable production hostname.
2. The Next.js catch-all route resolves or resumes the named Sandbox, waits for `/healthz`, and proxies the original request.
3. Exactly one Pocket ID process serves the SPA, WebAuthn ceremonies, OIDC endpoints, and API from the Sandbox.
4. Pocket ID reads and writes identity data in Neon through the unpooled Postgres connection.
5. The controller rewrites upstream redirects back to the stable hostname. The `sb-*.vercel.run` origin remains internal.

### Why the controller exists

Pocket ID embeds a francis actor host configured for one host per database. Direct Container Images Functions can overlap during scale-out or deployment. The second process then fails with `ErrClusterFull`.

The controller removes that race instead of hiding it:

- **One compute owner.** One named Sandbox runs one Pocket ID process against one identity database.
- **Stable identity boundary.** `APP_URL`, the OIDC issuer, and the WebAuthn RP ID all use the controller hostname.
- **Distributed lifecycle coordination.** Neon stores the Sandbox state and an expiring startup lease. Concurrent cold requests elect one starter; the rest wait for the same Sandbox.
- **Transparent scale-to-zero behavior.** A one-minute Vercel Cron stops and snapshots the named Sandbox after the idle threshold. The next ordinary request calls the Vercel Sandbox resume path and continues within the original HTTP request.
- **Deterministic restart.** Graceful shutdown completes before the stopped francis host row is removed, preventing the stale 90-second host slot from blocking restart.

### Runtime boundaries

| Boundary | Responsibility | Persistent state |
|---|---|---|
| Next.js controller on Fluid compute | Public reverse proxy, startup lease, health wait, redirect rewriting, idle control | None in process memory |
| Named Vercel Sandbox, 1 vCPU / 2 GB | One upstream Pocket ID v2.14.0 process | Persistent Sandbox filesystem with one retained snapshot |
| Neon Postgres | Pocket ID identity data, controller lifecycle state, and workshop setup | Durable Postgres data |

The Deploy Button uses one Neon store for both Pocket ID and controller tables to minimize workshop setup. Set `CONTROLLER_DATABASE_URL` only when you want the controller tables in a separate database.

## Validation status

The single-Sandbox controller, lifecycle lease, proxy, graceful stop, and restart behavior were tested in the predecessor implementation. The current Deploy Button path has not yet completed a fresh end-to-end run. In particular, first-boot binary download, the shared Neon database layout, instructor-console provisioning, QR signup, and cleanup still need validation together.

Treat the current template as workshop infrastructure under test until that run passes. No throughput or startup-time claim from the predecessor implementation is carried forward.

## Lifecycle

- `SANDBOX_IDLE_MINUTES` defaults to 120 so the Sandbox stays warm through workshop pauses. Lower it with an environment variable if shorter pauses are acceptable.
- The controller creates the Sandbox with a session timeout of `idle + 5 minutes` and extends that timeout when resuming a session near expiry.
- Stop sends SIGTERM, waits 12 seconds for Pocket ID and francis, removes the stopped host's database row, then stops the persistent Sandbox. This cleanup prevents the stale 90-second host slot from blocking restart.
- The next request acquires the Neon-backed startup lease, creates or resumes the named Sandbox, writes current environment variables into `/tmp/pocket-env.sh`, starts Pocket ID, waits for `/healthz`, and proxies the original request.
- Concurrent startup requests wait on that distributed lease and reuse the same Sandbox origin. Fluid compute can run controller invocations concurrently without starting a second Pocket ID process.
- Lifecycle state uses `CONTROLLER_DATABASE_URL` when set and otherwise uses the Neon-provided `DATABASE_URL`.
- The controller hostname is Pocket ID's `APP_URL`, OIDC issuer, and WebAuthn RP ID. Users never see the `sb-*.vercel.run` origin.

## First-run setup and secrets

The Deploy Button asks for nothing beyond a project name and the Neon store. On the first visit to the new deployment, every path redirects to `/setup`, where one click generates three secrets and stores them in the workshop's Neon database:

| Secret | Purpose | Who sees it |
|---|---|---|
| Pocket ID encryption key | Protects Pocket ID's stored private keys. Lives with the database it protects for the workshop's lifetime. | Nobody. Generated and consumed by the controller. |
| Pocket ID API key | Server-side provisioning from the instructor console. | Shown once on `/setup`; only needed if you use `setup.sh`. |
| Instructor password | Basic-auth password for `/workshop` (any username). Stored as a hash. | Shown once on `/setup`. Save it. |

The claim is atomic: exactly one visitor can complete setup, and after that `/setup` redirects to `/workshop` forever. If `/setup` reports that someone else already completed it, delete the project and Neon resource and deploy again.

This trades the wizard's three text boxes for a short window between "Ready" and your first visit during which the URL is unclaimed. For a disposable workshop owned by the deployer, that is an acceptable trade. Open the deployment as soon as it is Ready.

Because the encryption key is stored alongside the data it protects, Pocket ID's at-rest encryption only helps against leaks of the Pocket ID tables without the controller table. Treat the Neon resource as the sensitive asset and delete it after the event.

## Environment variables

| Variable | Required | Value / notes |
|---|---:|---|
| `DATABASE_URL_UNPOOLED` | yes | Pocket ID database; injected by the Neon store created in the wizard. |
| `DATABASE_URL` | yes | Controller state; injected by the same Neon store. The workshop template intentionally shares one Neon project for minimal setup. |
| `CONTROLLER_DATABASE_URL` | no | Optional override for a separate controller database. |
| `ENCRYPTION_KEY` | no | Overrides the generated key. Only for deployments that predate first-run setup or for local development. |
| `STATIC_API_KEY` | no | Overrides the generated Pocket ID API key. |
| `WORKSHOP_ADMIN_SECRET` | no | Overrides the generated instructor password. Set this and redeploy if the generated password is lost. |
| `APP_URL` | no | Exact controller origin. Omit for the standard `.vercel.app` project URL. |
| `SANDBOX_NAME` | no | Defaults to `pocket-id` within the deployed Vercel project. |
| `SANDBOX_IMAGE` | no | Optional custom VCR image. By default, first startup downloads and checksum-verifies Pocket ID v2.14.0 in a persistent Vercel-managed Sandbox. |
| `SANDBOX_IDLE_MINUTES` | no | Default 120 for long workshop pauses. |
| `SANDBOX_STARTUP_TIMEOUT_MS` | no | Default 60,000. |
| `LIFECYCLE_ADMIN_SECRET` | no | Only required for manual `POST /api/lifecycle/stop`. |
| `CRON_SECRET` | recommended | Vercel supplies this bearer value to cron calls. |

When all three of `ENCRYPTION_KEY`, `STATIC_API_KEY`, and `WORKSHOP_ADMIN_SECRET` are set, the first-run gate is skipped entirely. Pocket ID rate limiting is always disabled because hundreds of attendees share conference NAT addresses.

## Deploy

1. Click **Deploy with Vercel** above and choose a project and repository name. Use Pro or Enterprise: the one-minute idle cron does not deploy on Hobby, and Hobby Sandbox sessions cannot exceed 45 minutes.
2. In the wizard, create the Neon store. There are no environment variables to fill in.
3. When the deployment is Ready, open it immediately. Any URL redirects to `/setup`.
4. Click **Set up this workshop**. Copy the instructor password into your password manager, tick the confirmation, and continue.
5. Turn off Deployment Protection for the production deployment. OIDC back-channel clients cannot complete Vercel Authentication.
6. At `https://<project>.vercel.app/workshop`, enter any username and the instructor password in the browser prompt.
7. Click **Prepare workshop**. The first request creates the named persistent Sandbox, downloads the pinned Pocket ID binary, then creates the instructor admin, workshop group, fixed public PKCE client, and ten 100-use signup tokens valid for three days.
8. Put the displayed QR code or `/join` URL on the workshop slide. The stable link distributes requests across signup tokens with a combined limit of 1,000 completed signups.
9. Open the displayed one-time admin login in the instructor browser, add a passkey under **Settings → Account**, then use **Settings → Administration** for Pocket ID's built-in admin tools.

`setup.sh` remains available for custom headcounts, durations, usernames, or client settings; it needs the Pocket ID API key shown on `/setup`. The default workshop path needs no shell.

## Operations

```bash
# inspect without waking the Sandbox
curl https://<project>.vercel.app/api/lifecycle/status

# manual graceful stop (only when LIFECYCLE_ADMIN_SECRET is configured)
curl -X POST https://<project>.vercel.app/api/lifecycle/stop \
  -H "Authorization: Bearer $LIFECYCLE_ADMIN_SECRET"

# next ordinary request transparently resumes it
curl https://<project>.vercel.app/login
```

A stopped Sandbox does not accrue provisioned-memory usage, but its retained snapshot uses snapshot storage. The 120-minute idle default requires Pro or Enterprise and keeps the Sandbox available through workshop pauses; lower it after testing if shorter pauses are acceptable. Vercel Functions run the controller only when requests or the idle cron execute.

## Teardown


Delete both workshop resources after the event:

1. The Vercel project, including its named Sandbox and snapshots.
2. The Neon Marketplace resource, which contains attendee identity data and controller state.

Run `teardown.sh` to remove the Neon resource and project. Marketplace resources do not disappear when you delete only the Vercel project.

## Files

- `app/[[...path]]/route.ts` — stable public reverse proxy; buffers request/response bodies and rewrites upstream redirects.
- `app/api/lifecycle/{idle,status,stop}/route.ts` — cron, status, manual stop.
- `proxy.ts` — first-run gate (everything redirects to `/setup` until secrets exist) and Basic-auth guard for `/workshop`.
- `app/setup` and `app/api/setup` — one-time secret generation shown to the first visitor.
- `app/workshop` and `app/api/workshop` — password-protected one-click instructor console, slide QR, and admin handoff.
- `app/join/route.ts` — stable attendee URL distributed across ten 100-use signup tokens.
- `lib/secrets.ts` — Neon-backed generated secrets with environment-variable overrides and an atomic single-winner claim.
- `lib/workshop{,-store,-auth}.ts` — provisioning, controller-DB persistence, and instructor access checks.
- `lib/lifecycle-store.ts` — Neon state and expiring distributed lifecycle lease.
- `lib/sandbox-control.ts` — resume/start/readiness/session-extension/graceful-stop state machine.
- `image/Dockerfile` — optional custom VCR image source for Pocket ID v2.14.0; the Deploy Button path does not use it by default.
- `setup.sh` — optional CLI provisioner for custom workshop settings.
- `sandbox-up.mjs`, `sandbox-down.mjs` — optional manual Sandbox helpers; the Deploy Button path creates the Sandbox on demand.
