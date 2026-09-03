#!/usr/bin/env bash
# teardown.sh — delete a Pocket ID sidecar project AND its Neon resource.
#
# Marketplace resources do NOT die with the project; both must go, or the
# Neon database (and attendee PII) survives the workshop.
#
# Usage: ./teardown.sh <project-name> [--scope <team-slug>] [--yes]
# Example: ./teardown.sh idp-ws-2026-09-12-oidc --scope my-team --yes
set -euo pipefail

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then sed -n '2,8p' "$0"; exit 0; fi
PROJECT="${1:?usage: teardown.sh <project-name> [--scope <team>] [--yes]}"; shift
SCOPE_ARGS=()
ASSUME_YES=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --scope) SCOPE_ARGS+=(--scope "$2"); shift 2 ;;
    --yes) ASSUME_YES="--yes"; shift ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

confirm() {
  [[ -n "$ASSUME_YES" ]] && return 0
  read -r -p "$1 [y/N] " ans
  [[ "$ans" == "y" || "$ans" == "Y" ]]
}

echo "resources linked to $PROJECT:"
vercel integration list "$PROJECT" ${SCOPE_ARGS[@]+"${SCOPE_ARGS[@]}"} || true
echo ""
confirm "Delete Neon resource(s) above AND project $PROJECT?" || { echo "aborted."; exit 1; }

# Resources first: the project must still exist to disconnect cleanly, and the
# Neon DB (attendee PII) is the thing that survives if you stop halfway.
for res in $(vercel integration list "$PROJECT" ${SCOPE_ARGS[@]+"${SCOPE_ARGS[@]}"} --json 2>/dev/null \
  | python3 -c "import json,sys; [print(r['name']) for r in json.load(sys.stdin).get('resources',[])]" 2>/dev/null || true); do
  echo "disconnecting $res from $PROJECT…"
  vercel integration resource disconnect "$res" "$PROJECT" ${SCOPE_ARGS[@]+"${SCOPE_ARGS[@]}"} $ASSUME_YES || true
  echo "removing resource $res…"
  vercel integration resource remove "$res" ${SCOPE_ARGS[@]+"${SCOPE_ARGS[@]}"} $ASSUME_YES || true
done

echo "removing project $PROJECT…"
echo "(vercel project remove is interactive — confirm in the prompt)"
vercel project remove "$PROJECT" ${SCOPE_ARGS[@]+"${SCOPE_ARGS[@]}"}
echo "done. Verify in dashboard: project gone AND Neon resource gone."
