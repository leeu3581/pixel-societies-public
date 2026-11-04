#!/usr/bin/env bash
# Apply Pixel Societies migrations to one of: local | uat | prod.
#
# Wraps backend/scripts/db_push.py so we never accidentally point it at
# the wrong database. Each --env flag resolves to a specific env var:
#
#   --env=local  →  $LOCAL_DB_URL
#                   (defaults to postgresql://postgres:postgres@127.0.0.1:54322/postgres)
#   --env=uat    →  $UAT_DB_URL   (set in your shell or backend/.env.uat)
#   --env=prod   →  $PROD_DB_URL  (NEVER commit this; export it ad-hoc)
#
# Examples:
#   scripts/db-push.sh --env=local --dry-run
#   scripts/db-push.sh --env=uat
#   PROD_DB_URL='postgresql://...' scripts/db-push.sh --env=prod
#
# Prod intentionally has no fallback default — you must export PROD_DB_URL
# in the calling shell. That's the seatbelt.

set -euo pipefail

ENV_NAME=""
DRY_RUN=""
MARK_APPLIED=""

for arg in "$@"; do
  case "$arg" in
    --env=*) ENV_NAME="${arg#--env=}" ;;
    --dry-run) DRY_RUN="--dry-run" ;;
    --mark-applied) MARK_APPLIED="--mark-applied" ;;
    -h|--help)
      sed -n '2,18p' "$0" | sed 's/^# //; s/^#//'
      exit 0
      ;;
    *) echo "Unknown flag: $arg" >&2; exit 2 ;;
  esac
done

if [[ -z "$ENV_NAME" ]]; then
  echo "Usage: $0 --env=local|uat|prod [--dry-run]" >&2
  exit 2
fi

case "$ENV_NAME" in
  local)
    DB_URL="${LOCAL_DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
    ;;
  uat)
    DB_URL="${UAT_DB_URL:-}"
    if [[ -z "$DB_URL" ]]; then
      echo "!! UAT_DB_URL not set. Export the UAT pooler URL first." >&2
      echo "   (Find it in Supabase Studio → UAT project → Settings → Database)" >&2
      exit 3
    fi
    ;;
  prod)
    DB_URL="${PROD_DB_URL:-}"
    if [[ -z "$DB_URL" ]]; then
      echo "!! PROD_DB_URL not set. This is intentional — prod must be" >&2
      echo "   exported ad-hoc in your shell so you can't accidentally" >&2
      echo "   ship a migration to prod from a CI script." >&2
      exit 3
    fi
    echo "!! about to apply migrations to PRODUCTION." >&2
    read -p "Type 'yes' to continue: " confirm
    if [[ "$confirm" != "yes" ]]; then
      echo "aborted." >&2
      exit 4
    fi
    ;;
  *)
    echo "Unknown env: $ENV_NAME (use local|uat|prod)" >&2
    exit 2
    ;;
esac

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Use the backend venv if it exists (so asyncpg is available).
if [[ -x backend/.venv/bin/python ]]; then
  PYTHON="backend/.venv/bin/python"
else
  PYTHON="python3"
fi

echo "== applying migrations to $ENV_NAME =="
exec "$PYTHON" backend/scripts/db_push.py --db-url "$DB_URL" $DRY_RUN $MARK_APPLIED
