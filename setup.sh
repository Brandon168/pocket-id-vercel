#!/usr/bin/env bash
# setup.sh — idempotent post-deploy provisioning for a Pocket ID sidecar on Vercel.
#
# Usage:
#   ./setup.sh [--headcount N] [--days N] [--tokens N] [--admin-username NAME] [--admin-email EMAIL] [--admin-first-name NAME]
#
# Defaults: headcount 50, workshop length 2 days, 4 signup tokens, admin username "instructor".
# Pocket ID caps a single signup token at 100 uses: for headcount > ~80, mint several
# tokens (--tokens N, default 4 → 400 uses) and QR all of them. setup.sh spreads
# attendees across N parallel /signup links so no single token's usageLimit caps the rush.
# Requires: curl, python3. No other dependencies.
#
# Contract:
#   1. App config FIRST (fresh instances require user email — admin creation fails
#      without flipping it): signups withToken, requireUserEmail=false, no verification.
#   2. Ensure a real admin user exists; print a Login Code link for the instructor
#      (passkeys cannot be created via API — the instructor registers theirs in-browser).
#   3. Group "workshop"; OIDC client "workshop-app" (public, PKCE) with callback
#      wildcard https://*.vercel.app/api/auth/callback/pocket-id, restricted to "workshop".
#   4. Signup tokens: headcount + 20 % headroom spread across --tokens parallel
#      tokens (each capped at 100 uses), all defaulting to group "workshop".
#      Print every signup link (QR all of them).
#   5. CIMD allowlist is NOT set (Pocket ID validates callback patterns at the client;
#      RPs register via the admin UI or API).
#
# Operational rules (single-replica embedded actor host):
#   - Strictly serial API calls with SLEEP_SECS gaps; concurrent requests 500.
#   - A 500 is ambiguous (may have committed): every mutating step GET-verifies
#     before retrying. Never blind-retry a POST/PUT.
#   - Wait for the instance to be warm: /login 200 before starting.
set -euo pipefail

APP_URL="${APP_URL:?set APP_URL to the sidecar origin, e.g. https://idp-ws-2026-09-12-oidc.vercel.app}"
STATIC_API_KEY="${STATIC_API_KEY:?set STATIC_API_KEY to the project static API key}"
HEADCOUNT=50
DAYS=2
TOKENS=4
ADMIN_USERNAME="instructor"
ADMIN_EMAIL=""
ADMIN_FIRST_NAME="Instructor"
SLEEP_SECS=6

while [[ $# -gt 0 ]]; do
  case "$1" in
    --headcount) HEADCOUNT="$2"; shift 2 ;;
    --days) DAYS="$2"; shift 2 ;;
    --tokens) TOKENS="$2"; shift 2 ;;
    --admin-username) ADMIN_USERNAME="$2"; shift 2 ;;
    --admin-email) ADMIN_EMAIL="$2"; shift 2 ;;
    --admin-first-name) ADMIN_FIRST_NAME="$2"; shift 2 ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

API="$APP_URL/api"
AUTH_HEADER="X-API-Key: $STATIC_API_KEY"

api_call() { # method path [body-file]
  local req_method="$1" req_path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -sS -g --max-time 60 -X "$req_method" "$API$req_path" \
      -H 'Content-Type: application/json' -H "$AUTH_HEADER" -d @"$body"
  else
    curl -sS -g --max-time 60 -X "$req_method" "$API$req_path" -H "$AUTH_HEADER"
  fi
}

wait_warm() {
  echo "==> waiting for instance to be warm (/login 200)…"
  for _ in $(seq 1 30); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$APP_URL/login" || true)"
    if [[ "$code" == "200" ]]; then echo "    warm."; return 0; fi
    sleep 20
  done
  echo "instance never went warm; check deployment logs" >&2; exit 1
}

# --- 0. Warm gate: never provision against a cold/contended instance ----------
wait_warm

# --- 1. App config first: fresh instances require user email by default, and
# admin creation fails without one. Flip to token signups + no email requirement
# before creating anyone. (PUT replaces the ENTIRE config — always GET-modify-PUT.)
echo "==> step 1/4: app config (signups withToken, no email requirement)"
CUR="$(api_call GET "/application-configuration/all")"
sleep "$SLEEP_SECS"
UPD="$(mktemp)"; trap 'rm -f "$UPD"' EXIT
echo "$CUR" | python3 -c "
import json, sys
cur = {c['key']: c['value'] for c in json.load(sys.stdin)}
cur['allowUserSignups'] = 'withToken'
cur['requireUserEmail'] = 'false'
cur['emailsVerified'] = 'false'
cur['emailVerificationEnabled'] = 'false'
json.dump(cur, open('$UPD', 'w'))
"
api_call PUT "/application-configuration" "$UPD" >/dev/null
sleep "$SLEEP_SECS"
echo "    config updated."

# --- 2. Admin user -----------------------------------------------------------
echo "==> step 2/4: admin user"
ADMIN_JSON="$(api_call GET "/users?search=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$ADMIN_USERNAME")&pagination[limit]=5")"
sleep "$SLEEP_SECS"
ADMIN_ID="$(echo "$ADMIN_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(next((u['id'] for u in d.get('data',[]) if u.get('username')=='$ADMIN_USERNAME'),''))")"
ADMIN_IS_ADMIN="$(echo "$ADMIN_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); u=next((u for u in d.get('data',[]) if u.get('username')=='$ADMIN_USERNAME'),{}); print(str(u.get('isAdmin',False)))")"
if [[ -z "$ADMIN_ID" ]]; then
  echo "    creating admin user '$ADMIN_USERNAME'…"
  body="$(mktemp)"; trap 'rm -f "$body"' EXIT
  python3 - "$body" "$ADMIN_USERNAME" "$ADMIN_EMAIL" "$ADMIN_FIRST_NAME" <<'EOF'
import json, sys
path, username, email, first = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
doc = {"username": username, "firstName": first, "isAdmin": True}
if email: doc["email"] = email
json.dump(doc, open(path, "w"))
EOF
  CREATE_OUT="$(api_call POST "/users" "$body")"
  sleep "$SLEEP_SECS"
  ADMIN_ID="$(echo "$CREATE_OUT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))")"
  [[ -n "$ADMIN_ID" ]] || { echo "admin create failed: $CREATE_OUT" >&2; exit 1; }
elif [[ "$ADMIN_IS_ADMIN" != "True" ]]; then
  echo "admin exists but is not admin — refusing to change roles automatically" >&2; exit 1
else
  echo "    admin exists: $ADMIN_ID"
fi
# The instructor runs the workshop: ensure membership in the attendee group later
# (group id unknown until step 3).
INSTRUCTOR_NEEDS_GROUP=1

echo "    minting Login Code for instructor (15-min default)…"
TOKEN="$(api_call POST "/users/$ADMIN_ID/one-time-access-token" /dev/stdin <<<'{}' | python3 -c "import json,sys; print(json.load(sys.stdin)['token'])")"
sleep "$SLEEP_SECS"
echo ""
echo "    INSTRUCTOR LOGIN (valid ~15 min, single use):"
echo "    $APP_URL/lc/$TOKEN"
echo "    Open it in the browser that will hold the instructor passkey,"
echo "    then /settings/account -> Add passkey."
echo ""

# --- 3. Group + OIDC client ---------------------------------------------------
echo "==> step 3/4: group 'workshop' + client 'workshop-app'"
GROUP_JSON="$(api_call GET "/user-groups?search=workshop&pagination[limit]=5")"
sleep "$SLEEP_SECS"
GROUP_ID="$(echo "$GROUP_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(next((g['id'] for g in d.get('data',[]) if g.get('name')=='workshop'),''))")"
if [[ -z "$GROUP_ID" ]]; then
  body="$(mktemp)"; echo '{"friendlyName":"workshop","name":"workshop"}' >"$body"
  GROUP_ID="$(api_call POST "/user-groups" "$body" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")"
  rm -f "$body"; sleep "$SLEEP_SECS"
  echo "    created group $GROUP_ID"
else
  echo "    group exists: $GROUP_ID"
fi

CLIENT_JSON="$(api_call GET "/oidc/clients/workshop-app" || true)"
sleep "$SLEEP_SECS"
if echo "$CLIENT_JSON" | grep -q '"id":"workshop-app"'; then
  echo "    client exists: workshop-app"
else
  body="$(mktemp)"; cat >"$body" <<'EOF'
{"id":"workshop-app","name":"Workshop App","description":"Workshop RP (public, PKCE)",
 "callbackURLs":["https://*.vercel.app/api/auth/callback/pocket-id"],
 "logoutCallbackURLs":[],"isPublic":true,"pkceEnabled":true,"skipConsent":true}
EOF
  api_call POST "/oidc/clients" "$body"
  rm -f "$body"; sleep "$SLEEP_SECS"
  VERIFY="$(api_call GET "/oidc/clients/workshop-app")"
  sleep "$SLEEP_SECS"
  echo "$VERIFY" | grep -q '"id":"workshop-app"' || { echo "client create unverified: $VERIFY" >&2; exit 1; }
  echo "    created client workshop-app"
fi

api_call PUT "/oidc/clients/workshop-app/allowed-user-groups" /dev/stdin <<<"{\"userGroupIds\":[\"$GROUP_ID\"]}" >/dev/null
sleep "$SLEEP_SECS"
echo "    client restricted to group workshop."
if [[ "${INSTRUCTOR_NEEDS_GROUP:-0}" == "1" ]]; then
  echo "    adding instructor to group workshop (merge with existing members)…"
  EXISTING="$(api_call GET "/user-groups/$GROUP_ID")"
  sleep "$SLEEP_SECS"
  MERGED="$(echo "$EXISTING" | ADMIN_ID="$ADMIN_ID" python3 -c "import json,os,sys; g=json.load(sys.stdin); ids=[u['id'] for u in g.get('users',[])]; a=os.environ['ADMIN_ID']; print(json.dumps({'userIds': ids if a in ids else ids+[a]}))")"
  echo "$MERGED" > /tmp/pid_members.json
  api_call PUT "/user-groups/$GROUP_ID/users" /tmp/pid_members.json >/dev/null
  rm -f /tmp/pid_members.json; sleep "$SLEEP_SECS"
  echo "    instructor added."
fi

# --- 4. Signup tokens ---------------------------------------------------------
# Headroom +20 % spread across $TOKENS parallel tokens (server caps each at 100
# uses). Parallel links keep a stampede from piling onto one token's counter;
# attendees split across them (rotate the QR slides, or print one QR per table).
echo "==> step 4/4: signup tokens (x$TOKENS)"
TOTAL_NEED=$(( (HEADCOUNT * 12 / 10) ))
PER_TOKEN=$(( (TOTAL_NEED + TOKENS - 1) / TOKENS ))
# Pocket ID caps usageLimit at 100 (signupTokenCreateDto binding max=100).
if [[ "$PER_TOKEN" -gt 100 ]]; then
  echo "    WARNING: headcount $HEADCOUNT needs $TOTAL_NEED uses but $TOKENS tokens x 100 cap = $(( TOKENS * 100 )). Mint more with --tokens." >&2
  PER_TOKEN=100
fi
# Go time.ParseDuration has no day unit — send hours ("24h", "48h", …).
TTL_STR="$(( DAYS * 24 ))h"
echo ""
echo "    ATTENDEE SIGNUP ($TOKENS parallel links, $PER_TOKEN uses each, expires in $DAYS day(s) — QR all of these):"
i=1
while [[ "$i" -le "$TOKENS" ]]; do
  body="$(mktemp)"; echo "{\"ttl\":\"${TTL_STR}\",\"usageLimit\":$PER_TOKEN,\"userGroupIds\":[\"$GROUP_ID\"]}" >"$body"
  TOKEN_JSON="$(api_call POST "/signup-tokens" "$body")"
  rm -f "$body"; sleep "$SLEEP_SECS"
  if ! SIGNUP_TOKEN="$(echo "$TOKEN_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['token'])")" \
    || [[ -z "$SIGNUP_TOKEN" ]]; then
    echo "signup token $i/$TOKENS create failed (empty response is usually a 500 under replica contention" >&2
    echo "— check whether tokens already exist: GET /api/signup-tokens, then retry setup.sh)." >&2
    echo "raw response: $TOKEN_JSON" >&2
    exit 1
  fi
  echo "    [$i/$TOKENS] $APP_URL/signup?token=$SIGNUP_TOKEN"
  i=$(( i + 1 ))
done
echo ""
echo "done."
