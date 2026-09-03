# Pocket ID on Vercel — workshop sidecar

Run the upstream [Pocket ID](https://github.com/pocket-id/pocket-id) passkey-only OIDC provider on Vercel without changing its Go backend or embedded SvelteKit frontend. A thin Next.js controller gives browsers and relying-party apps one stable origin while a single persistent Vercel Sandbox satisfies Pocket ID's single-replica constraint.

This is a workshop sidecar: provision it for an event, let it idle to zero, then remove the Sandbox, identity database, and controller state.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FBrandon168%2Fpocket-id-vercel&project-name=idp-ws-DATE-TOPIC&repository-name=idp-ws-DATE-TOPIC&env=ENCRYPTION_KEY%2CSTATIC_API_KEY%2CWORKSHOP_ADMIN_SECRET%2CDISABLE_RATE_LIMITING%2CSANDBOX_IDLE_MINUTES&envDefaults=%7B%22DISABLE_RATE_LIMITING%22%3A%22true%22%2C%22SANDBOX_IDLE_MINUTES%22%3A%22120%22%7D&envDescription=Enter%20three%20random%20secrets.%20The%20workshop%20console%20creates%20everything%20else.%20Save%20ENCRYPTION_KEY%20until%20the%20workshop%20is%20deleted.&envLink=https%3A%2F%2Fgithub.com%2FBrandon168%2Fpocket-id-vercel%23environment-variables&stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22neon%22%2C%22productSlug%22%3A%22neon%22%2C%22protocol%22%3A%22storage%22%7D%5D)

## Architecture

![Pocket ID on Vercel architecture: a stable Next.js controller proxies OIDC traffic to one Vercel Sandbox, with Neon storing identity and lifecycle state.](assets/pocket-id-vercel-architecture.jpg)

> **Tested envelope:** 300 virtual users against Pocket ID directly, plus a constant 300 requests per second through the Fluid compute controller for 90 seconds. Both completed with zero HTTP failures. After the named Sandbox reached `stopped`, the next request resumed it and returned the complete login page in 2.29 seconds. Twenty simultaneous requests during resume returned 20/20 HTTP 200 in 1.32–1.79 seconds through one startup lease.

The wake-up path is a **Vercel Sandbox resume**, not a second Pocket ID replica. The controller Function may incur its own Fluid compute cold start, but every invocation coordinates on the same named Sandbox and Neon-backed lease. These tests prove the request path and resume coordination; they do not yet model 300 simultaneous passkey ceremonies or account-creation writes.

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
- **Distributed lifecycle coordination.** A separate Neon database stores the Sandbox state and an expiring startup lease. Concurrent cold requests elect one resumer; the rest wait for the same Sandbox.
- **Transparent scale-to-zero behavior.** A one-minute Vercel Cron stops and snapshots the named Sandbox after the idle threshold. The next ordinary request calls the Vercel Sandbox resume path and continues within the original HTTP request.
- **Deterministic restart.** Graceful shutdown completes before the stopped francis host row is removed, preventing the stale 90-second host slot from blocking restart.

### Runtime boundaries

| Boundary | Responsibility | Persistent state |
|---|---|---|
| Next.js controller on Fluid compute | Public reverse proxy, startup lease, health wait, redirect rewriting, idle control | None in process memory |
| Named Vercel Sandbox, 1 vCPU / 2 GB | One unchanged Pocket ID v2.14.0 process | One retained Sandbox snapshot |
| Pocket ID Neon database | Users, passkeys, groups, OIDC clients, files, and francis actor state | Durable Postgres data |
| Controller Neon database | Lifecycle status, last request time, startup lease, origin, and errors | Durable Postgres data |

The identity and controller databases must be logically separate. The Sandbox is the only Pocket ID compute replica; the Fluid controller can scale independently because its coordination state lives in Neon.

## Measured behavior (2026-09-03)

| Test | Result |
|---|---|
| Direct Function, 2 VUs | 30–40% 500 (`ErrClusterFull`) |
| Direct 4-vCPU Sandbox, 300 VUs / 271,336 reads | 0 failures, p95 206 ms, max 1.5 s |
| Vercel Sandbox resume after `stopped` | HTTP 200 with the complete 5,375-byte login page in 1.62–2.33 s; latest measured resume was 2.29 s |
| 20 simultaneous requests during Sandbox resume | 20/20 HTTP 200 in 1.32–1.79 s through one Neon-backed startup lease |
| Controller stop | 15–16 s including Pocket ID's 10-second actor shutdown grace and snapshot |
| Controller immediate restart after deterministic host cleanup | 200 in 1.77 s |
| 2-vCPU Sandbox through controller, accidental ~1,300 req/s | Found controller lifecycle-DB connection exhaustion; Pocket ID remained fast. Drove hot-origin caching and activity-write coalescing. |
| Tuned 2-vCPU controller, bounded 300 rps for 90 s | **26,912 requests, zero failures**, p95 149 ms, max 1.25 s; ~99.7 MB peak cgroup memory of 4 GB (~2.4%) |
| Tuned 1-vCPU controller, bounded 300 rps for 90 s | **26,899 requests, zero failures**, p95 156 ms, max 1.55 s; ~100.6 MB peak of 2 GB (~4.8%), zero CPU throttling |

The accidental ~1,300 req/s run is retained as common-sense tuning evidence: it was far above the 300-user workshop target, showed no Pocket ID memory/CPU symptom, and isolated per-request controller work as the bottleneck. Hot origins are cached per Function instance, lifecycle activity writes are coalesced, bodyless 204 responses are handled correctly, and sessions are extended through the idle horizon. Both bounded 300-rps reruns passed cleanly: 2 vCPU peaked around 103 MB; 1 vCPU peaked around 101 MB with no CPU throttling and only 7 ms additional p95 latency. The default is therefore **1 vCPU / 2 GB**, the smallest Sandbox size; use 2 vCPU for extra CPU headroom during unusually write-heavy workshops.

## Lifecycle

- `SANDBOX_IDLE_MINUTES` defaults to 30. A one-minute Vercel Cron stops the Sandbox after no proxied request for that interval.
- Any request extends the Sandbox session timeout to at least `idle + 5 minutes`, avoiding expiry during an auth flow.
- Stop sends SIGTERM, waits 12 seconds for Pocket ID/francis, removes the stopped host's database row, then snapshots and stops the Sandbox. This deterministic cleanup is required because francis otherwise retains the single-host slot for 90 seconds.
- The next request acquires the Neon-backed startup lease, calls Vercel Sandbox resume, writes current env into `/tmp/pocket-env.sh`, starts Pocket ID, waits for `/healthz`, then proxies the original request.
- Concurrent resume requests wait on that distributed lease and reuse the same Sandbox origin. Fluid compute can execute controller invocations concurrently without starting a second Pocket ID process.
- State and startup leases live in `CONTROLLER_DATABASE_URL`, not process memory. The controller DB must be separate from Pocket ID's database.
- The controller hostname is Pocket ID's `APP_URL`, OIDC issuer, and WebAuthn RP ID. Users never see `sb-*.vercel.run`.

## Environment variables

| Variable | Required | Value / notes |
|---|---:|---|
| `DATABASE_URL_UNPOOLED` | yes | Pocket ID database; injected by the Neon store created in the wizard. |
| `DATABASE_URL` | yes | Controller state; injected by the same Neon store. The workshop template intentionally shares one Neon project for minimal setup. |
| `CONTROLLER_DATABASE_URL` | no | Optional override for a separate controller database. |
| `ENCRYPTION_KEY` | yes | Random value, at least 16 bytes; stable for this Pocket ID DB. |
| `STATIC_API_KEY` | yes | Random value, at least 16 characters; used only by server-side workshop provisioning. |
| `WORKSHOP_ADMIN_SECRET` | yes | Password for the instructor console at `/workshop`. |
| `APP_URL` | no | Exact controller origin. Omit for the standard `.vercel.app` project URL. |
| `SANDBOX_NAME` | no | Defaults to `pocket-id` within the deployed Vercel project. |
| `SANDBOX_IMAGE` | no | Optional custom VCR image. By default, first startup downloads and checksum-verifies Pocket ID v2.14.0 in a persistent Vercel-managed Sandbox. |
| `SANDBOX_IDLE_MINUTES` | no | Wizard default 120 for long workshop pauses. |
| `SANDBOX_STARTUP_TIMEOUT_MS` | no | Default 60,000. |
| `DISABLE_RATE_LIMITING` | no | Wizard default `true` for conference NAT. |
| `LIFECYCLE_ADMIN_SECRET` | no | Only required for manual `POST /api/lifecycle/stop`. |
| `CRON_SECRET` | recommended | Vercel supplies this bearer value to cron calls. |

## Deploy

1. Click **Deploy with Vercel** above and choose a project/repository name.
2. In the wizard, create the Neon store and enter three random values: `ENCRYPTION_KEY`, `STATIC_API_KEY`, and `WORKSHOP_ADMIN_SECRET`. Leave the two defaults unchanged.
3. Wait for the deployment to become Ready. The first workshop request creates the named persistent Sandbox and downloads the pinned Pocket ID binary automatically.
4. Deployment Protection must remain off because OIDC back-channel clients cannot complete Vercel Authentication.
5. Open `https://<project>.vercel.app/workshop` and enter `WORKSHOP_ADMIN_SECRET` when the browser prompts.
6. Click **Prepare workshop**. No configuration questions: it creates the instructor admin, workshop group, fixed public PKCE client, and ten 100-use signup pools valid for three days.
7. Put the displayed QR code or `/join` URL on the workshop slide. The stable link distributes up to 1,000 attendees across the signup pools.
8. Open the displayed one-time admin login in the instructor browser, add a passkey under **Settings → Account**, then use **Settings → Administration** for Pocket ID's built-in admin tools.

`setup.sh` remains available for custom headcounts, durations, usernames, or client settings; the default workshop path needs no shell.

## Operations

```bash
# inspect without waking the Sandbox
curl https://<project>.vercel.app/api/lifecycle/status

# manual graceful stop
curl -X POST https://<project>.vercel.app/api/lifecycle/stop \
  -H "Authorization: Bearer $LIFECYCLE_ADMIN_SECRET"

# next ordinary request transparently resumes it
curl https://<project>.vercel.app/login
```
A stopped Sandbox does not accrue provisioned-memory cost. A running 1-vCPU Sandbox has 2 GB provisioned memory (~$0.0424/hour in `iad1`) plus active CPU. Default 30-minute idle grace costs at most ~$0.021 after the last auth request. The Vercel controller Function uses Fluid pricing and is idle between requests.

## Teardown

Delete all three durable resources:

1. Named Sandbox and its snapshots.
2. Pocket ID Neon database (attendee PII).
3. Controller state database/project.

`teardown.sh` remains for the older direct-Function project shape. Marketplace resources do not disappear with project deletion.

## Files

- `app/[[...path]]/route.ts` — stable public reverse proxy; buffers request/response bodies and rewrites upstream redirects.
- `app/api/lifecycle/{idle,status,stop}/route.ts` — cron, status, manual stop.
- `app/workshop` and `app/api/workshop` — password-protected one-click instructor console, slide QR, and admin handoff.
- `app/join/route.ts` — stable attendee URL distributed across ten 100-use signup tokens.
- `lib/workshop{,-store,-auth}.ts` — provisioning, controller-DB persistence, and instructor access checks.
- `lib/lifecycle-store.ts` — Neon state and expiring distributed lifecycle lease.
- `lib/sandbox-control.ts` — resume/start/readiness/session-extension/graceful-stop state machine.
- `image/Dockerfile` — Pocket ID v2.14.0 upstream OCI image, no upstream code changes.
- `setup.sh` — idempotent Pocket ID provisioning and parallel signup tokens.
- `sandbox-up.mjs`, `sandbox-down.mjs` — manual bootstrap/debug helpers.
