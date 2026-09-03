# Pocket ID on Vercel — workshop sidecar

Run the upstream [Pocket ID](https://github.com/pocket-id/pocket-id) passkey-only OIDC provider on Vercel without changing its Go backend or embedded SvelteKit frontend. A thin Next.js controller gives browsers and relying-party apps one stable origin while a single persistent Vercel Sandbox satisfies Pocket ID's single-replica constraint.

This is a workshop sidecar: provision it for an event, let it idle to zero, then remove the Sandbox, identity database, and controller state.

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
| `DATABASE_URL_UNPOOLED` | yes | Pocket ID's unpooled Neon URL. |
| `CONTROLLER_DATABASE_URL` | yes | Separate logical Neon DB for `pocket_id_sandbox_lifecycle`; pooled URL is fine. |
| `ENCRYPTION_KEY` | yes | `openssl rand -base64 32`; stable for this Pocket ID DB, save in password manager. |
| `STATIC_API_KEY` | yes | `openssl rand -hex 32`; drives `setup.sh`. |
| `APP_URL` | yes | Exact production controller origin; set before first passkey. |
| `SANDBOX_NAME` | yes | Stable named Sandbox, e.g. `idp-ws-2026-09-12-oidc`. |
| `SANDBOX_IDLE_MINUTES` | no | Default 30. Production env changes require controller redeploy. Set 60–120 for a workshop with long pauses. |
| `SANDBOX_STARTUP_TIMEOUT_MS` | no | Default 15,000; 30,000 recommended. |
| `DISABLE_RATE_LIMITING` | no | `true` for conference NAT. |
| `LIFECYCLE_ADMIN_SECRET` | yes | Protects manual `POST /api/lifecycle/stop`. |
| `CRON_SECRET` | recommended | Vercel supplies this bearer value to cron calls. |

## Deploy

1. Provision Neon. Use one project with two logical databases or two branches:
   - Pocket ID DB → `DATABASE_URL_UNPOOLED`
   - controller state DB → `CONTROLLER_DATABASE_URL`
2. Deploy once to build `image/Dockerfile` into VCR, then create the named persistent Sandbox from that ready `dockerfile` image with port 1411, **1 vCPU / 2 GB**, `keepLastSnapshots: { count: 1 }`, and at least a 5-minute session timeout.
3. Configure all variables above in Production. Deployment Protection must be off: OIDC back-channel clients cannot complete Vercel Authentication.
4. Deploy the Next.js controller (`npm install && vercel deploy --prod`).
5. Open `https://<project>.vercel.app/login`. First access resumes/starts the Sandbox. Confirm `GET /api/lifecycle/status` reports both lifecycle and Sandbox `running`.
6. Provision the workshop:

```bash
APP_URL=https://<project>.vercel.app \
STATIC_API_KEY=<static-key> \
./setup.sh --headcount 300 --tokens 4 --days 2
```

Pocket ID caps one signup token at 100 uses. `--tokens 4` creates 400 uses across four QR links; print one per room/table and keep an extra token for latecomers.

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
- `lib/lifecycle-store.ts` — Neon state and expiring distributed lifecycle lease.
- `lib/sandbox-control.ts` — resume/start/readiness/session-extension/graceful-stop state machine.
- `image/Dockerfile` — Pocket ID v2.14.0 upstream OCI image, no upstream code changes.
- `setup.sh` — idempotent Pocket ID provisioning and parallel signup tokens.
- `sandbox-up.mjs`, `sandbox-down.mjs` — manual bootstrap/debug helpers.
