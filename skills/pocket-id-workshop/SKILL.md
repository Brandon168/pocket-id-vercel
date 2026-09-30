---
name: pocket-id-workshop
description: Stand up, connect, run, and tear down a disposable passkey identity provider (Pocket ID on Vercel) for a workshop. Use when someone wants workshop attendees to sign in with passkeys, needs attendees provisioned into a Vercel Enterprise team without personal signups, asks to "set up workshop auth", "deploy Pocket ID", "connect the workshop IdP to my Vercel team", "get the QR code for signups", "why isn't an attendee showing up in Vercel", or "tear down the workshop IdP".
metadata:
  author: Brandon Elliott
  version: "1.0.0"
  repository: https://github.com/Brandon168/pocket-id-vercel
---

# Pocket ID workshop identity provider

Scope: this skill and `docs/vercel-team-setup.md` cover Pocket ID only. Keep customer-specific Entra or other IdP guides separate; do not adapt these Custom OIDC screenshots into a named-provider SAML walkthrough. The September 5 rehearsal verified configuration but did not establish a successful attendee landing on a non-test Enterprise team. Require a real attendee dry run before an event; do not describe this as an already-proven end-to-end workshop outcome.

Vercel staff: the internal runbook for the workshop team, domain, and cleanup is the Notion page [Workshop test teams with temporary accounts (Pocket ID on Vercel)](https://app.notion.com/p/vercel/Workshop-test-teams-with-temporary-accounts-Pocket-ID-on-Vercel-3d2e06b059c481088028c25ff2985c0f). Point Vercel users there for the team-creation step.

One deployment per workshop. Attendees open a short `/join` link on their workshop laptop, pick a username, and create a passkey. QR is optional. Runs upstream Pocket ID inside a Vercel Sandbox behind a small Next.js controller with an instructor console at `/workshop`. Pocket ID admin is the separate upstream UI for users and clients. Deleted after the event.

Three modes, chosen at first run and locked after preparation:

| Mode | Attendees sign in to | What you get |
|---|---|---|
| **Passport** | Deployed workshop apps, including published v0 apps | Confidential `workshop-passport` with a stored secret, exact callback `https://connect.vercel.com/callback`; an Enterprise team Owner connects Vercel Passport |
| **App** | An app the room is building | OIDC client `workshop-app` (public, PKCE) accepting any `https://*.vercel.app/api/auth/callback/pocket-id` |
| **Vercel team** | A Vercel Enterprise team (and v0) via SSO + Directory Sync + Enterprise Managed Users | Confidential client `vercel-sso` with a stored secret, SCIM push, every attendee registered as `username@<verified domain>` |

Before doing anything, ask (or infer) three things: **which mode**, **which Vercel team to deploy into**, and **how many attendees**. For team mode also settle the **email domain**, the **team slug**, and the **Owner's Vercel login email**.

### Choosing the email domain (team mode)

Enterprise Managed Users requires a domain controlled by the organizer, verified on the participant team with a TXT record. Buying a domain through Vercel is supported; an existing domain also works. A `*.vercel.app` host cannot be verified. To find existing domains:

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

Or from a checkout: `./deploy.sh --scope <team> --project <name>`. Options: `--idle-minutes`, `--database-url`/`--database-url-unpooled` (bring your own Postgres), `--existing-project`, `--ref`, `--repo <owner/name>` (template repo; private repos work when `gh` is signed in).

If the template repo is private, `raw.githubusercontent.com` returns 404. Fetch the script with `gh api repos/<owner>/<repo>/contents/deploy.sh -H 'Accept: application/vnd.github.raw' | bash -s -- --repo <owner>/<repo> --scope …` instead.

Alternative: the **Deploy with Vercel** button in the README (same result; clones a repo into the user's GitHub).

The script first reads the hosting team's defaults (`vercel api /v2/teams/<slug>`, read-only) and stops before creating anything if a setting would break the IdP: Deployment Protection on all domains, a Passport default for new projects, or Hobby. It warns about automatic project expiry and short production retention. Relay those lines to the user; only pass `--skip-preflight` if they will fix the project setting by hand before `/setup`.

Requirements the script cannot fix for you, check them with the user first:

- **Pro or Enterprise team.** The idle cron runs every minute and Sandboxes exceed Hobby limits.
- **The production `.vercel.app` domain must stay public.** Attendees have no Vercel account yet, and Vercel's SSO must fetch the discovery document. Standard Deployment Protection is fine; "All Deployments" or a team policy enforcing authentication on production domains is not. Vercel Toolbar and WAF challenge mode also break Pocket ID.
- **Neon Marketplace install can fail** if the team hasn't accepted Neon's terms or you can't install integrations. Bring your own Postgres with `--database-url`.
- **Project expiration.** Some internal teams expire new projects after a month by default. Extend or turn off expiration on the IdP project if the workshop, or the team SSO that depends on it, lasts longer.
- **Pick the project name once.** Passkeys are bound to the hostname; renaming or adding a custom domain later invalidates every passkey.

Verify: `curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://<project>.vercel.app/` → `307 …/setup`.

## Step 2: First-run setup (the user does this, in their browser)

Tell the user to open `https://<project>.vercel.app/setup` **immediately**: the first visitor owns the workshop. Walk them through the single screen:

1. Mode card: "Deployed apps with Vercel Passport" for app protection, "An app with its own OIDC integration" for auth-library workshops, or "A Vercel Enterprise team" for team accounts.
2. Team mode only: the verified email domain (e.g. `workshop-2026.example.com`). Attendees are always registered as `username@thatdomain`, whatever they type.
3. Room size (50–1,000). Capacity is size × 1.2 rounded up to 100-use signup tokens behind one stable `/join` URL. 100 attendees creates 2 tokens; 1,000 creates 12, adding ten serial API calls and ten default one-second pauses. Attendee accounts are created at signup. This is separate from Vercel billing seats; Flex does not require preset seat quantities. Check the actual trial/plan and entitlements rather than assuming every Enterprise trial is Flex.
4. Click **Set up this workshop**. An instructor password appears once (have them save it; their browser is already signed in via cookie). The workshop prepares itself in the background; "Workshop ready" appears in roughly 15–60 seconds. Then **Open instructor console**.

If the user cannot use a browser right now, the same can be done with curl (the response sets the instructor cookie):

```bash
curl -s -c jar.txt -H 'content-type: application/json' \
  -d '{"mode":"app","expectedAttendees":100}' https://<project>.vercel.app/api/setup
# team mode: -d '{"mode":"vercel-team","emailDomain":"workshop-2026.example.com","expectedAttendees":100}'
curl -s -b jar.txt -X POST https://<project>.vercel.app/api/workshop/setup   # blocks until ready (≤ 5 min)
```

Keep `adminSecret` from the first response: it is the instructor password and the Basic-auth secret for every `/api/workshop/*` call (`curl -u ":<password>" …`).

## Step 3 (Passport mode): connect deployed apps

Use Passport for app protection; it does not provision Vercel or v0 accounts. The instructor console at `/workshop` prepares a separate confidential `workshop-passport` client restricted to the workshop group and shows its saved secret. `GET /api/workshop/passport` requires instructor authentication, uses `no-store`, and does not wake an idle Sandbox.

1. A Vercel Enterprise team Owner creates an **OAuth Connect application → Your own credentials** from Passport settings. Use the issuer as **Server URL**, select **Discover**, and enter the console's client ID and secret. Request `openid`; add `profile` and `email` if needed.
2. The client callback is exactly `https://connect.vercel.com/callback`.
3. Enable Passport on the workshop app projects and select the Connect application. Team defaults apply to new projects; explicitly assign existing projects. Keep the Pocket ID issuer public and outside the Passport protection it supplies.
4. Dry run: open `/join` on an attendee laptop → register/passkey → visit a protected deployment → confirm actual sign-in and verified app identity.

Published v0 apps and the v0 editor sandbox are different environments. Real Pocket ID identity in the editor sandbox remains unverified. A local development identity fixture is not evidence of real IdP login. Consult [Passport setup](https://vercel.com/docs/passport/set-up-identity-provider) and [identity validation](https://vercel.com/docs/passport/read-identity).

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
5. Dry run with one throwaway attendee before the event: open `/join` on a laptop → username + passkey → wait a minute → sign in at `https://vercel.com/login?saml=<slug>` → confirm Member role. EMU enrollment is generally available; no separate availability flag check is needed. Verify the actual Enterprise team allows these attendees; do not assume a restricted `vtest` team is suitable.

## Step 4: run the day

- Lead the slide with `https://<project>.vercel.app/join` and ask attendees to open it on their workshop laptop. Optional QR (public SVG): `https://<project>.vercel.app/api/workshop/qr?url=https%3A%2F%2F<project>.vercel.app%2Fjoin&download=1`. Slide copy: *username = firstname-lastname; create a passkey when asked.* Email is optional unless the workshop requires it.
- Signup count without waking Pocket ID: `GET /api/workshop/signups`.
- Signup expires 72 hours after Prepare. Prepared early, or a multi-day event: `POST /api/workshop/signups` renews it for 72 hours with fresh tokens behind the same `/join` link (starts Pocket ID if idle). `/join` answering 410 means signup has expired.
- Attendee list: `GET /api/workshop/attendees?search=<term>&page=1` (add `&wake=1` if Pocket ID is idle). Each row shows `hasPasskey`.
- Attendee locked out or skipped passkey: `POST /api/workshop/login-link {"userId":"…"}` → one-time 12-character code and link, valid one hour, no email.
- Attendee missing in Vercel (team mode): check the row's email has the right domain, then `POST /api/workshop/vercel/sync`. `GET /api/workshop/vercel` shows `scim.lastError` in plain language when a push failed.
- Instructor needs Pocket ID admin: `POST /api/workshop/admin-login` → one-time URL that lands on `/settings/admin/users` as `instructor`. A second admin named `static-api-user-…` is the console's service account; do not delete it.
- Health: `GET /api/lifecycle/status` (public, never wakes the Sandbox; send the instructor Basic auth to also get `lastError`, the lease, and the Sandbox origin). Idle stop after `SANDBOX_IDLE_MINUTES` (default 120); the next request resumes it in-line.

## Step 5: tear down

While the IdP still works, remove Passport assignments and any team default that uses this provider. In team mode, disable SSO enforcement, remove Directory Sync and SSO, and retire managed accounts/domain associations through the approved team process. Then delete the IdP resources below; never strand protected apps or an enforced team by deleting the IdP first.

```bash
./teardown.sh <project> --scope <team> --yes     # removes the Neon resource, then the project
```

Or by hand: `vercel integration resource remove <project>-db --disconnect-all --yes`, then `vercel project remove <project>`. Once the IdP is gone, no attendee account can sign in again.

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
| Neon install fails during deploy | Terms not accepted, missing permission, or a plan choice is required; see deploy.sh's message. Use `--database-url`. |
| `/api/lifecycle/status` shows `failed` | The next real request retries the start automatically; read `lastError` (instructor auth required). |
