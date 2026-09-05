#!/usr/bin/env bash
# deploy.sh — stand up a workshop identity provider from your terminal.
#
# Same result as the Deploy Button, without cloning a GitHub repo into your
# account: creates the Vercel project, attaches a Neon database (or uses one
# you bring), deploys, and opens /setup. Two clicks after that and the QR code
# is ready.
#
# Usage:
#   ./deploy.sh --scope <team-slug> [--project <name>] [options]
#   curl -fsSL https://raw.githubusercontent.com/Brandon168/pocket-id-vercel/main/deploy.sh | bash -s -- --scope <team-slug>
#
# Options:
#   --scope <team>                 Vercel team slug to deploy into (required). Its production
#                                  .vercel.app domain must be allowed to stay public.
#   --project <name>               Project name; becomes https://<name>.vercel.app.
#                                  Default: idp-ws-<YYYYMMDD>. Lowercase letters, digits, dashes.
#   --database-url <url>           Bring your own Postgres instead of installing Neon.
#   --database-url-unpooled <url>  Direct (non-pooled) URL for the same database; Pocket ID
#                                  needs it. Defaults to --database-url when omitted.
#   --neon-plan <plan-id>          Neon plan id if your team requires choosing one.
#   --idle-minutes <n>             Stop the Sandbox after this long without traffic (default 120).
#   --ref <git-ref>                Branch or tag of the template to deploy (default main).
#   --source <dir>                 Deploy a local checkout instead of cloning (for development).
#   --existing-project             Reuse an existing project of this name instead of creating it.
#   --no-open                      Do not open /setup in a browser when done.
#   -h, --help                     Show this help.
#
# Requires: vercel CLI (logged in), git, curl. Pro or Enterprise team.
set -euo pipefail

REPO_URL="https://github.com/Brandon168/pocket-id-vercel.git"
SCOPE=""
PROJECT=""
DB_URL=""
DB_URL_UNPOOLED=""
NEON_PLAN=""
IDLE_MINUTES=""
REF="main"
SOURCE=""
EXISTING=""
OPEN_BROWSER=1

usage() {
  if [[ -f "$0" ]]; then sed -n '2,29p' "$0"; else echo "usage: deploy.sh --scope <team-slug> [--project <name>] [--database-url <url>] [--no-open]"; fi
}

die() { printf '\n\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
step() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --scope) SCOPE="$2"; shift 2 ;;
    --project) PROJECT="$2"; shift 2 ;;
    --database-url) DB_URL="$2"; shift 2 ;;
    --database-url-unpooled) DB_URL_UNPOOLED="$2"; shift 2 ;;
    --neon-plan) NEON_PLAN="$2"; shift 2 ;;
    --idle-minutes) IDLE_MINUTES="$2"; shift 2 ;;
    --ref) REF="$2"; shift 2 ;;
    --source) SOURCE="$2"; shift 2 ;;
    --existing-project) EXISTING=1; shift ;;
    --no-open) OPEN_BROWSER=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown flag: $1 (see --help)" ;;
  esac
done

for tool in vercel git curl; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required. Install it and run again."
done

step "Checking Vercel login"
if ! WHO="$(vercel whoami 2>/dev/null | tail -1)"; then
  die "Not logged in. Run: vercel login"
fi
note "signed in as $WHO"

if [[ -z "$SCOPE" ]]; then
  echo
  vercel teams ls 2>/dev/null || true
  die "Pass --scope <team-slug> (one of the ids above). The team must allow its production domain to stay public."
fi

if [[ -z "$PROJECT" ]]; then PROJECT="idp-ws-$(date +%Y%m%d)"; fi
[[ "$PROJECT" =~ ^[a-z0-9]([a-z0-9-]{0,98}[a-z0-9])?$ ]] || die "Project name must be lowercase letters, digits, and dashes: $PROJECT"
if [[ -n "$DB_URL" && -z "$DB_URL_UNPOOLED" ]]; then DB_URL_UNPOOLED="$DB_URL"; fi
if [[ -z "$DB_URL" && -n "$DB_URL_UNPOOLED" ]]; then die "--database-url-unpooled needs --database-url too"; fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/pocket-id-deploy.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

step "Fetching the template"
if [[ -n "$SOURCE" ]]; then
  note "copying $SOURCE"
  ( cd "$SOURCE" && tar --exclude=.vercel --exclude=node_modules --exclude=.next --exclude=.git --exclude=.local -cf - . ) | ( cd "$WORK" && tar -xf - )
else
  note "git clone --depth 1 --branch $REF"
  git clone --quiet --depth 1 --branch "$REF" "$REPO_URL" "$WORK"
fi
[[ -f "$WORK/vercel.json" ]] || die "template checkout looks wrong (no vercel.json)"

step "Creating project $PROJECT in $SCOPE"
if [[ -n "$EXISTING" ]]; then
  note "reusing existing project"
else
  if ! vercel project add "$PROJECT" --scope "$SCOPE" >/dev/null 2>"$WORK/project-add.err"; then
    cat "$WORK/project-add.err" >&2
    die "Could not create project $PROJECT. If it already exists, pass --existing-project or pick another --project name."
  fi
  note "created"
fi
vercel link --project "$PROJECT" --scope "$SCOPE" --yes --cwd "$WORK" >/dev/null 2>&1 || die "vercel link failed"

add_env() {
  local name="$1" value="$2"
  printf '%s' "$value" | vercel env add "$name" production --scope "$SCOPE" --cwd "$WORK" >/dev/null 2>&1 \
    || die "Could not set $name. If the project already has it, remove it in the dashboard or pass --existing-project with a fresh name."
  note "$name set"
}

step "Database"
if [[ -n "$DB_URL" ]]; then
  note "using the Postgres you provided"
  add_env DATABASE_URL "$DB_URL"
  add_env DATABASE_URL_UNPOOLED "$DB_URL_UNPOOLED"
else
  note "installing Neon from the Vercel Marketplace"
  NEON_ARGS=(integration add neon --scope "$SCOPE" --cwd "$WORK" --name "$PROJECT-db" --no-env-pull -e production -e preview -e development)
  [[ -n "$NEON_PLAN" ]] && NEON_ARGS+=(-p "$NEON_PLAN")
  if ! vercel "${NEON_ARGS[@]}"; then
    cat <<EOF >&2

Neon could not be installed on this team. Two known causes:
  • The team is a child of a Vercel Organization (Marketplace installs are rejected there today).
  • The team needs a plan choice: run  vercel integration add neon --scope $SCOPE  once by hand and
    re-run this script with --existing-project --neon-plan <id>.
Or bring your own Postgres (Neon, Supabase, RDS…) and re-run with:
  ./deploy.sh --scope $SCOPE --project $PROJECT --existing-project \\
    --database-url 'postgresql://…?sslmode=require' --database-url-unpooled 'postgresql://…?sslmode=require'
EOF
    exit 1
  fi
fi

if [[ -n "$IDLE_MINUTES" ]]; then
  step "Sandbox idle timeout"
  add_env SANDBOX_IDLE_MINUTES "$IDLE_MINUTES"
fi

step "Deploying to production (about a minute)"
if ! vercel deploy --prod --yes --scope "$SCOPE" --cwd "$WORK" >"$WORK/deploy.log" 2>&1; then
  tail -20 "$WORK/deploy.log" >&2
  die "Deployment failed. Full log above."
fi
URL="https://$PROJECT.vercel.app"
note "deployed"

step "Waiting for $URL"
READY=0
for _ in $(seq 1 20); do
  CODE="$(curl -s -o /dev/null -w '%{http_code}' "$URL/" || true)"
  if [[ "$CODE" == "307" || "$CODE" == "200" ]]; then READY=1; break; fi
  sleep 3
done
if [[ "$READY" != 1 ]]; then
  note "the production domain is not answering yet (last status: ${CODE:-none})."
  note "if it never does, check Deployment Protection: the production domain must stay public."
fi

# Team mode needs an email domain the team can verify. Show what this team
# already owns so the instructor picks a subdomain instead of buying one.
# (the CLI prints this table on stderr; rows are indented, the header row starts with "Domain")
DOMAINS="$(vercel domains ls --scope "$SCOPE" 2>&1 | awk '/^  [A-Za-z0-9]/ && $1 != "Domain" {print $1}' | head -12 || true)"
if [[ -n "$DOMAINS" ]]; then
  step "Domains this team already owns"
  note "If attendees will get Vercel accounts (Vercel team mode), use a dedicated subdomain of one of these"
  note "as the email domain at /setup, e.g. workshop.<domain>. You verify it later with one TXT record."
  while IFS= read -r d; do note "  $d"; done <<< "$DOMAINS"
fi

printf '\n\033[1mDone.\033[0m Open this now, before anyone else does:\n'
cat <<EOF

    $URL/setup

The first visitor owns the workshop. On /setup: pick what attendees sign in to (an app you are
building, or a Vercel Enterprise team), the room size, then one click. Your instructor password
is shown once; the workshop prepares itself in the background and the console has the QR code.

Later:
    curl -s $URL/api/lifecycle/status      # is Pocket ID running? (never wakes it)
    ./teardown.sh $PROJECT --scope $SCOPE  # delete the project AND the Neon database

EOF

if [[ "$OPEN_BROWSER" == 1 ]]; then
  if command -v open >/dev/null 2>&1; then open "$URL/setup" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL/setup" >/dev/null 2>&1 || true
  fi
fi
