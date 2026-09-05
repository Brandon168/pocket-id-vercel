#!/usr/bin/env bash
# teardown.sh — delete a workshop identity provider project AND its Neon resource.
#
# Marketplace resources do NOT die with the project; both must go, or the
# Neon database (and attendee identities) survives the workshop.
#
# Usage: ./teardown.sh <project-name> [--scope <team-slug>] [--yes]
# Example: ./teardown.sh idp-ws-20260912 --scope my-team --yes
set -euo pipefail

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then sed -n '2,8p' "$0"; exit 0; fi
PROJECT="${1:?usage: teardown.sh <project-name> [--scope <team>] [--yes]}"; shift
SCOPE_ARGS=()
ASSUME_YES=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --scope) SCOPE_ARGS+=(--scope "$2"); shift 2 ;;
    --yes) ASSUME_YES="1"; shift ;;
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
confirm "Delete the resource(s) above AND project $PROJECT?" || { echo "aborted."; exit 1; }

# Resources first: the project must still exist to disconnect cleanly, and the
# Neon database is the thing that survives if you stop halfway.
RESOURCES="$(vercel integration list "$PROJECT" ${SCOPE_ARGS[@]+"${SCOPE_ARGS[@]}"} --json 2>/dev/null \
  | python3 -c "import json,sys; [print(r['name']) for r in json.load(sys.stdin).get('resources',[])]" 2>/dev/null || true)"
for res in $RESOURCES; do
  echo "removing resource ${res} (disconnecting all projects first)..."
  vercel integration resource remove "$res" --disconnect-all --yes ${SCOPE_ARGS[@]+"${SCOPE_ARGS[@]}"} \
    || echo "  could not remove $res automatically; delete it under Storage in the dashboard." >&2
done

echo "removing project ${PROJECT}..."
if [[ -n "$ASSUME_YES" ]]; then
  # vercel project remove has no --yes flag and still prompts under --non-interactive.
  printf 'y\n' | vercel project remove "$PROJECT" ${SCOPE_ARGS[@]+"${SCOPE_ARGS[@]}"}
else
  echo "(confirm in the prompt)"
  vercel project remove "$PROJECT" ${SCOPE_ARGS[@]+"${SCOPE_ARGS[@]}"}
fi
echo "done. Verify in the dashboard: project gone AND Neon resource gone."
