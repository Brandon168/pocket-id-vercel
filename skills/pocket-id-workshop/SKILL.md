---
name: pocket-id-workshop
description: Stand up, connect, run, and tear down a disposable passkey identity provider (Pocket ID on Vercel) for a workshop. Use when someone wants workshop attendees to sign in with passkeys, needs attendees provisioned into a Vercel Enterprise team without personal signups, asks to "set up workshop auth", "deploy Pocket ID", "connect the workshop IdP to my Vercel team", "get the QR code for signups", "why isn't an attendee showing up in Vercel", or "tear down the workshop IdP".
metadata:
  author: Brandon Elliott
  version: "1.0.0"
  repository: https://github.com/Brandon168/pocket-id-vercel
---

# Pocket ID workshop identity provider

One deployment per workshop. Attendees scan a QR code, pick a username, create a passkey, done. Runs upstream Pocket ID inside a Vercel Sandbox behind a small Next.js controller with an instructor console at `/workshop`. Deleted after the event.

Two modes, chosen once at first run:

| Mode | Attendees sign in to | What you get |
|---|---|---|
| **App** | An app the room is building | OIDC client `workshop-app` (public, PKCE) accepting any `https://*.vercel.app/api/auth/callback/pocket-id` |
| **Vercel team** | A Vercel Enterprise team (and v0) via SSO + Directory Sync + Enterprise Managed Users | Confidential client `vercel-sso` with a stored secret, SCIM push, every attendee registered as `username@<verified domain>` |

Before doing anything, ask (or infer) three things: **which mode**, **which Vercel team to deploy into**, and **how many attendees**. For team mode also ask for the **email domain verified on the target team** and the **team slug**.

## Step 1: Deploy (about a minute)

Preferred: the CLI script. No GitHub clone, no prompts.

```bash
vercel whoami                      # must be logged in; otherwise: vercel login
vercel teams ls                    # pick the team slug
curl -fsSL https://raw.githubusercontent.com/Brandon168/pocket-id-vercel/main/deploy.sh \
  | bash -s -- --scope <team-slug> --project idp-ws-<yyyymmdd>-<topic> --no-open
```

Or from a checkout: `./deploy.sh --scope <team> --project <name>`. Options: `--idle-minutes`, `--database-url`/`--database-url-unpooled` (bring your own Postgres), `--existing-project`, `--ref`.

Alternative: the **Deploy with Vercel** button in the README (same result; clones a repo into the user's GitHub).

Requirements the script cannot fix for you, check them with the user first:

- **Pro or Enterprise team.** The idle cron runs every minute and Sandboxes exceed Hobby limits.
- **The production `.vercel.app` domain must stay public.** Attendees have no Vercel account yet, and Vercel's SSO must fetch the discovery document. Standard Deployment Protection is fine; "All Deployments" or a team policy enforcing authentication on production domains is not. Vercel Toolbar and WAF challenge mode also break Pocket ID.
- **Neon Marketplace install may be rejected on teams that are children of a Vercel Organization.** If `vercel integration add neon` fails, deploy into a standalone team or bring your own Postgres with `--database-url`.
- **Pick the project name once.** Passkeys are bound to the hostname; renaming or adding a custom domain later invalidates every passkey.

Verify: `curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://<project>.vercel.app/` → `307 …/setup`.

## Step 2: First-run setup (the user does this, in their browser)

Tell the user to open `https://<project>.vercel.app/setup` **immediately**: the first visitor owns the workshop. Walk them through the single screen:

1. Mode card: "An app you are building" or "A Vercel Enterprise team".
2. Team mode only: the verified email domain (e.g. `workshop-2026.example.com`). Attendees are always registered as `username@thatdomain`, whatever they type.
3. Room size (50–1,000). Capacity is size × 1.2 in 100-use signup tokens behind one stable `/join` URL.
4. Click **Set up this workshop**. An instructor password appears once (have them save it; their browser is already signed in via cookie). The workshop prepares itself in the background; "Workshop ready" appears in roughly 15–60 seconds. Then **Open instructor console**.

If the user cannot use a browser right now, the same can be done with curl (the response sets the instructor cookie):

```bash
curl -s -c jar.txt -H 'content-type: application/json' \
  -d '{"mode":"app","expectedAttendees":100}' https://<project>.vercel.app/api/setup
# team mode: -d '{"mode":"vercel-team","emailDomain":"workshop-2026.example.com","expectedAttendees":100}'
curl -s -b jar.txt -X POST https://<project>.vercel.app/api/workshop/setup   # blocks until ready (≤ 5 min)
```

Keep `adminSecret` from the first response: it is the instructor password and the Basic-auth secret for every `/api/workshop/*` call (`curl -u ":<password>" …`).

## Step 3 (team mode): connect the Vercel team

Only a team **Owner** can do this, in the Vercel dashboard: **Settings → Security & Privacy → Authentication and User Provisioning**. The console's **Vercel team** panel shows every value with copy buttons, or fetch them:

```bash
curl -s -u ":<password>" https://<project>.vercel.app/api/workshop/vercel
# → discoveryUrl, clientId (vercel-sso), clientSecret, callbackUrl, signInUrl, memberGroup, workshopGroup, scim
```

1. **SAML → Configure → Custom OIDC.** Provider name `Pocket ID`. Paste Discovery endpoint, Client ID, Client secret. Vercel's login redirect URL (`https://auth.vercel.com/sso/oidc/<id>/callback`) is already accepted by a wildcard; only pin it (`PATCH {"callbackUrl": "…"}`) if Vercel rejects the connection.
2. **Directory Sync → Configure → Custom SCIM.** Provider `Pocket ID`, Bearer token. Vercel shows an endpoint (`https://auth.vercel.com/scim/v2.0/<id>`) and a token (`se_…`). Enter both in the console, or:
   ```bash
   curl -s -u ":<password>" -H 'content-type: application/json' \
     -d '{"endpoint":"https://auth.vercel.com/scim/v2.0/<id>","token":"se_…"}' https://<project>.vercel.app/api/workshop/vercel
   ```
   This pushes immediately; Vercel lets you save the directory once the first push lands. Afterwards every signup is pushed automatically (~15 s) and Vercel applies it within about a minute.
3. **Map groups → enable EMU.** Map `workshop` to **Member** (or an Access Group). Attendees are also in `vercel-role-member`, which Vercel treats as Member even unmapped. The Owner must keep themselves an Owner before confirming the first sync, then enable Enterprise Managed Users (needs SSO + Directory Sync + verified domain).
4. Set the team slug so attendees get a **Vercel** tile and the console shows the sign-in link:
   ```bash
   curl -s -u ":<password>" -X PATCH -H 'content-type: application/json' -d '{"teamSlug":"<slug>"}' https://<project>.vercel.app/api/workshop/vercel
   ```
5. Dry run with one throwaway attendee before the event: scan → username + passkey → wait a minute → sign in at `https://vercel.com/login?saml=<slug>` → confirm Member role.

## Step 4: run the day

- QR code (public SVG): `https://<project>.vercel.app/api/workshop/qr?url=https%3A%2F%2F<project>.vercel.app%2Fjoin&download=1`. Slide copy: *username = firstname-lastname; email can be left blank; create a passkey when asked.*
- Signup count without waking Pocket ID: `GET /api/workshop/signups`.
- Attendee list: `GET /api/workshop/attendees?search=<term>&page=1` (add `&wake=1` if Pocket ID is idle). Each row shows `hasPasskey`.
- Attendee locked out or skipped passkey: `POST /api/workshop/login-link {"userId":"…"}` → one-time 12-character code and link, valid one hour, no email.
- Attendee missing in Vercel (team mode): check the row's email has the right domain, then `POST /api/workshop/vercel/sync`. `GET /api/workshop/vercel` shows `scim.lastError` in plain language when a push failed.
- Instructor needs Pocket ID admin: `POST /api/workshop/admin-login` → one-time URL that lands on `/settings/admin/users` as `instructor`. A second admin named `static-api-user-…` is the console's service account; do not delete it.
- Health: `GET /api/lifecycle/status` (public, never wakes the Sandbox). Idle stop after `SANDBOX_IDLE_MINUTES` (default 120); the next request resumes it in-line.

## Step 5: tear down

```bash
./teardown.sh <project> --scope <team> --yes     # removes the Neon resource, then the project
```

Or by hand: `vercel integration resource remove <project>-db --disconnect-all --yes`, then `vercel project remove <project>`. Team mode: also remove SSO and Directory Sync from the Vercel team, or its managed users remain. Once the IdP is gone, no attendee account can sign in again.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `/setup` says someone already completed setup | Someone else visited first. Treat as compromised: tear down and redeploy. |
| Console 401 on another device | Use the instructor password with an empty username in the Basic-auth prompt, or set `WORKSHOP_ADMIN_SECRET` on the project and redeploy if lost. |
| Passkeys stop working | Hostname changed (rename, custom domain, deployment URL). Not recoverable; redeploy. |
| Attendee provisioned as viewer | Directory Sync role mapping missing; map `workshop` → Member. `vercel-role-member` covers this by default. |
| Attendee typed the wrong email domain | Cannot happen in team mode; the proxy rewrites it. Check `/api/workshop/attendees`. |
| Neon install fails during deploy | Organization child team or plan choice required; see deploy.sh's message. Use `--database-url` or a standalone team. |
| `/api/lifecycle/status` shows `failed` | The next real request retries the start automatically; read `lastError`. |
