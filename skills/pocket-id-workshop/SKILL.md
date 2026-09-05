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

Before doing anything, ask (or infer) three things: **which mode**, **which Vercel team to deploy into**, and **how many attendees**. For team mode also settle the **email domain**, the **team slug**, and the **Owner's Vercel login email**.

### Choosing the email domain (team mode)

Enterprise Managed Users requires a domain verified on the participant team with one TXT record. Do not let the user buy a domain or try a `*.vercel.app` host (Vercel's zone cannot be verified). Instead:

```bash
vercel domains ls --scope <participant-team>     # domains the team already owns
vercel domains ls --scope <other-team-they-own>  # a domain elsewhere in their account works too
```

Recommend a **dedicated subdomain per event**, e.g. `workshop.example.com` or `<event>.workshop.example.com`: a subdomain can only be claimed by one team at a time, it never has to point anywhere, and no email is ever sent. If the zone is on Vercel DNS you can add the verification record yourself when Vercel shows it (step 3 below); otherwise the user adds it at their registrar.

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

1. **SAML → Configure → Custom OIDC, then enforce.** Provider name `Pocket ID`. Paste Discovery endpoint, Client ID, Client secret. Vercel's login redirect URL (`https://auth.vercel.com/sso/oidc/<id>/callback`) is already accepted by a wildcard; only pin it (`PATCH {"callbackUrl": "…"}`) if Vercel rejects the connection. For the sign-in test and for **Re-Authenticate** on the Security page, sign in through Pocket ID as `instructor` (mint a link with `POST /api/workshop/admin-login`). Then enable **Require team members to log in with SAML**. Warn the user: enforcing 403s every personal Vercel token for that team immediately.
2. **Directory Sync → Configure → Custom SCIM, no role mapping yet.** Provider `Pocket ID`, Bearer token. Vercel shows an endpoint (`https://auth.vercel.com/scim/v2.0/<id>`) and a token (`se_…`). Enter both in the console, or:
   ```bash
   curl -s -u ":<password>" -H 'content-type: application/json' \
     -d '{"endpoint":"https://auth.vercel.com/scim/v2.0/<id>","token":"se_…"}' https://<project>.vercel.app/api/workshop/vercel
   ```
   This pushes immediately; Vercel lets you finish once the first push lands. When Vercel offers role mapping, pick **Set Up Enterprise Managed Users First**. Mapping before EMU creates ordinary invitations that stop working when EMU turns on.
3. **Enable EMU and verify the domain.** EMU toggle → Manage Domains → Configure Domain (opens a hosted page in the same tab; open in a new tab) → enter the domain from `/setup` → add the TXT record it shows (host = the domain or subdomain, value `vercel-domain-verification-…`). If the zone is on Vercel DNS: `vercel dns add <zone> <host> TXT "<value>" --scope <zone-owner-team>`. Verification is automatic within about a minute. Back on Security, toggle EMU again, select the domain, and in Select Teams confirm ONLY the intended team (the sheet lists every eligible team the Owner has). Then **Manage Mappings**: `vercel-role-member`/`vercel-role-owner` are locked to Member/Owner; map `workshop` → Member. The `instructor` identity is pushed in `vercel-role-owner` (email `instructor@<domain>`, or set `{"instructorEmail": "<owner's Vercel login email>"}` via PATCH to keep an existing account), so the Owner cannot be locked out. Without EMU, SSO works but Vercel asks each attendee to create or link a regular Vercel account.
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
| Attendee reaches Vercel but is asked to "Connect Account" / sign up | EMU is not enabled on the team (needs enforced SAML + Directory Sync + verified domain). |
| Attendee SSO ends on `failed_to_provision_enterprise_user` | Vercel created the managed account but the team refused the join (member-domain restriction, seat limit, or role rule); the page hides the reason. Check the team's member restrictions first; otherwise ask Vercel support with team id and timestamp. Do not let attendees use the personal-login buttons on that page. |
| Personal token / CLI gets 403 for the team | SAML enforcement invalidates existing tokens for that team. Re-authenticate via SAML or create a new token from a SAML session. |
| Attendee shows as "Pending invitation" in the team | Expected until they complete SSO sign-in; Vercel applies SCIM pushes within about a minute. |
| Vercel's provider picker shows "Continue setup" drafts | Stale drafts from earlier attempts; choosing Custom OIDC / Custom SCIM resets them, which is fine. |
| Attendee typed the wrong email domain | Cannot happen in team mode; the proxy rewrites it. Check `/api/workshop/attendees`. |
| Neon install fails during deploy | Organization child team or plan choice required; see deploy.sh's message. Use `--database-url` or a standalone team. |
| `/api/lifecycle/status` shows `failed` | The next real request retries the start automatically; read `lastError`. |
