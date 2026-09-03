# Pocket ID on Vercel — workshop sidecar

Passkey-only OIDC provider ([Pocket ID](https://github.com/pocket-id/pocket-id), Go + embedded SvelteKit SPA), unchanged upstream.

## Architecture

```text
browser / RP (stable project hostname)
        |
        v
Vercel Next.js controller
  - proxies every request
  - Neon-backed lifecycle lease
  - resumes one persistent Sandbox on demand
  - one-minute cron stops it after idle timeout
        |
        v
one Vercel Sandbox (2 vCPU / 4 GB default)
  - one Pocket ID process (satisfies max-hosts=1)
  - public sandbox route is an internal origin only
        |
        v
Neon Postgres
  - Pocket ID identity data
  - separate logical DB for controller lifecycle state
```

Pocket ID's embedded francis host permits one replica per database. Direct Container Images Functions scale out on overlap, so newcomers crash with `ErrClusterFull`. The controller keeps Pocket ID in exactly one Sandbox, gives users a stable `.vercel.app` origin, and makes the stopped state transparent: the cold request waits while the Sandbox resumes.

## Measured behavior (2026-09-03)

| Test | Result |
|---|---|
| Direct Function, 2 VUs | 30–40% 500 (`ErrClusterFull`) |
| Direct 4-vCPU Sandbox, 300 VUs / 271,336 reads | 0 failures, p95 206 ms, max 1.5 s |
| Controller cold GET after stopped Sandbox | 200 with complete 5,375-byte page in 1.62–2.33 s |
| 20 simultaneous cold GETs | 20/20 HTTP 200, 1.32–1.79 s, one leased resume |
| Controller stop | 15–16 s including Pocket ID's 10-second actor shutdown grace and snapshot |
| Controller immediate restart after deterministic host cleanup | 200 in 1.77 s |
| 2-vCPU Sandbox through controller, accidental ~1,300 req/s | Found controller lifecycle-DB connection exhaustion; Pocket ID remained fast. Drove hot-origin caching and activity-write coalescing. |
| Tuned 2-vCPU controller, bounded 300 rps for 90 s | **26,912 requests, zero failures**, p95 149 ms, max 1.25 s; ~99.7 MB peak cgroup memory of 4 GB (~2.4%) |

The accidental ~1,300 req/s run is retained as common-sense tuning evidence: it was far above the 300-user workshop target, showed no Pocket ID memory/CPU symptom, and isolated per-request controller work as the bottleneck. Hot origins are now cached per Function instance, lifecycle activity writes are coalesced, bodyless 204 responses are handled correctly, and sessions are extended through the idle horizon. The bounded 300-rps rerun passed cleanly with ~97.6% RAM headroom. The default is **2 vCPU / 4 GB**; use 4 vCPU only if a future realistic journey benchmark demonstrates CPU or latency pressure.

## Lifecycle

- `SANDBOX_IDLE_MINUTES` defaults to 30. A minute cron stops the Sandbox after no proxied request for that interval.
- Any request extends the active session to at least `idle + 5 minutes`, avoiding a timeout during an auth flow.
- Stop sends SIGTERM, waits 12 seconds for Pocket ID/francis, removes the stopped host's database row, then snapshots/stops the VM. This deterministic cleanup is required because francis otherwise retains the single-host slot for 90 seconds.
- Next request resumes the named Sandbox, writes current env into `/tmp/pocket-env.sh`, starts Pocket ID, waits for `/healthz`, then proxies the original request.
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
2. Deploy once to build `image/Dockerfile` into VCR, then create the named persistent Sandbox from that ready `dockerfile` image with port 1411, **2 vCPU / 4 GB**, `keepLastSnapshots: { count: 1 }`, and at least a 5-minute session timeout.
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

A stopped Sandbox does not accrue provisioned-memory cost. A running 2-vCPU Sandbox has 4 GB provisioned memory (~$0.0848/hour in `iad1`) plus active CPU. Default 30-minute idle grace costs at most ~$0.042 after the last auth request. The Vercel controller Function uses Fluid pricing and is idle between requests.

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
