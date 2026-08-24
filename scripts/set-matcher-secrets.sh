#!/usr/bin/env bash
#
# set-matcher-secrets.sh — provision the matcher's two runtime secrets.
#
# ⚠ THESE ARE COPIES OF EXISTING SECRETS, NOT FRESH ONES. The matcher takes over the
# "classroom side" of talking to the Beer Game, so its secret VALUES must MATCH what is
# already deployed elsewhere — a fresh `openssl rand` (what spawn-secret.sh does) would
# guarantee a permanent 403. So this script COPIES:
#
#   matcher-mygames-live / PROVISION_SECRET_BEERGAME
#       ← beergame-mygames-live / CLASSROOM_PROVISION_SECRET
#       (the secret beergame's provisionClassSession validates; the matcher SENDS it)
#
#   matcher-mygames-live / CALLBACK_SECRET_BEERGAME
#       ← mygames-classroom-aec1b / CALLBACK_SECRET_BEERGAME
#       (the classroom's beergame callback secret; the matcher's syncRoster/getRoster
#        present it to read the course roster)
#
# Writes each to the matcher project's Secret Manager AND to functions/.secret.local
# (the emulator mirror), following spawn-secret.sh's invariants:
#   • the value NEVER touches a terminal, a log, argv, or shell history — it is read into a
#     shell variable from gcloud and only ever piped via stdin (`printf '%s' | ... --data-file=-`);
#   • written with `printf '%s'` (NO trailing newline): Secret Manager keeps whitespace
#     verbatim while the Firebase CLI strips trailing whitespace on deploy, so a trailing
#     newline is a permanent mismatch (callback/provision 403);
#   • the local mirror is functions/.secret.local (next to functions/package.json), never
#     the repo root (root → the emulator falls through to live GCP Secret Manager).
#   • Idempotent: an existing Secret Manager secret gets a NEW VERSION; .secret.local keys
#     are upserted (other keys preserved).
#
# Prereq: Secret Manager API enabled on matcher-mygames-live, and gcloud authenticated
# with access to ALL THREE projects. Does NOT enable APIs or grant IAM.

set -euo pipefail

MATCHER_PROJECT="matcher-mygames-live"
BEERGAME_PROJECT="beergame-mygames-live"
CLASSROOM_PROJECT="mygames-classroom-aec1b"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FUNCTIONS_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)/functions"
LOCAL_FILE="${FUNCTIONS_DIR}/.secret.local"

if [[ ! -d "$FUNCTIONS_DIR" ]]; then
  echo "  [FATAL] ${FUNCTIONS_DIR} not found — run from the mygames-matcher repo." >&2
  exit 2
fi

overall_ok=1

# read_src <src-project> <src-name> → echoes the value on stdout (for capture only).
# Fatal if the source secret is missing — copying "nothing" would silently deploy a
# broken hand-off.
read_src() {
  local project="$1" name="$2"
  if ! gcloud secrets versions access latest --secret="$name" --project "$project" 2>/dev/null; then
    echo "  [FATAL] source secret '${name}' not found in ${project}." >&2
    echo "          Provision it there first (beergame: scripts/set-game-secrets.sh;" >&2
    echo "          classroom callback: scripts/spawn-secret.sh beergame)." >&2
    exit 3
  fi
}

# write_sm <dst-name> <value> — value on stdin only, never argv.
write_sm() {
  local name="$1" value="$2"
  if gcloud secrets describe "$name" --project "$MATCHER_PROJECT" >/dev/null 2>&1; then
    if printf '%s' "$value" | gcloud secrets versions add "$name" --project "$MATCHER_PROJECT" --data-file=- >/dev/null 2>&1; then
      echo "  [OK]   ${name}: added new version  (project ${MATCHER_PROJECT})"
    else
      echo "  [FAIL] ${name}: could not add a new version  (project ${MATCHER_PROJECT})" >&2; overall_ok=0
    fi
  else
    if printf '%s' "$value" | gcloud secrets create "$name" --project "$MATCHER_PROJECT" --replication-policy=automatic --data-file=- >/dev/null 2>&1; then
      echo "  [OK]   ${name}: created  (project ${MATCHER_PROJECT})"
    else
      echo "  [FAIL] ${name}: could not create  (project ${MATCHER_PROJECT})" >&2; overall_ok=0
    fi
  fi
}

# upsert_local <name> <value> — replace this key's line, keep others, no trailing newline.
upsert_local() {
  local name="$1" value="$2" other=""
  [[ -f "$LOCAL_FILE" ]] && other="$(grep -v "^${name}=" "$LOCAL_FILE" || true)"
  {
    [[ -n "$other" ]] && printf '%s\n' "$other"
    printf '%s' "${name}=${value}"
  } > "$LOCAL_FILE"
}

copy() {
  local src_project="$1" src_name="$2" dst_name="$3"
  local value
  value="$(read_src "$src_project" "$src_name")"
  write_sm "$dst_name" "$value"
  upsert_local "$dst_name" "$value"
  unset value
}

echo "Provisioning matcher secrets (project ${MATCHER_PROJECT}) by COPYING existing values:"
echo "  PROVISION_SECRET_BEERGAME  ← ${BEERGAME_PROJECT}/CLASSROOM_PROVISION_SECRET"
echo "  CALLBACK_SECRET_BEERGAME   ← ${CLASSROOM_PROJECT}/CALLBACK_SECRET_BEERGAME"
echo "  local mirror               = ${LOCAL_FILE}"
echo

copy "$BEERGAME_PROJECT"  "CLASSROOM_PROVISION_SECRET" "PROVISION_SECRET_BEERGAME"
copy "$CLASSROOM_PROJECT" "CALLBACK_SECRET_BEERGAME"   "CALLBACK_SECRET_BEERGAME"

echo
if [[ "$overall_ok" -eq 1 ]]; then
  echo "✅ Both matcher secrets provisioned (values not shown), matching their sources."
  exit 0
else
  echo "❌ One or more secrets failed — see [FAIL] lines. Fix before deploying." >&2
  exit 1
fi
